// Post queue: posts can go out now or at a scheduled time. A small worker
// loop picks up due posts while the server is running.
import path from "node:path";
import fs from "node:fs";
import { uid } from "./store.js";
import * as tiktok from "./tiktok.js";
import * as instagram from "./instagram.js";

const ACTIVE = new Set(["queued", "uploading", "processing"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Publisher {
  constructor(store, accounts, clips) {
    this.store = store;
    this.accounts = accounts;
    this.clips = clips;
    this.running = new Set();
    // Anything that was mid-flight when the server stopped is marked failed so
    // it does not silently double-post on restart.
    this.store.update("posts", [], (posts) =>
      posts.map((p) =>
        p.status === "uploading" || p.status === "processing"
          ? { ...p, status: "failed", error: "The server stopped while this was posting. Check the platform before retrying." }
          : p
      )
    );
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref?.();
  }

  list() {
    return this.store.read("posts", []).slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    return this.store.read("posts", []).find((p) => p.id === id);
  }

  patch(id, fields) {
    let out;
    this.store.update("posts", [], (posts) =>
      posts.map((p) => (p.id === id ? (out = { ...p, ...fields, updatedAt: Date.now() }) : p))
    );
    return out;
  }

  log(id, message) {
    const post = this.get(id);
    if (!post) return;
    this.patch(id, { stage: message, log: [...(post.log || []), { at: Date.now(), message }].slice(-30) });
  }

  create({ clipId, caption, platforms, scheduleAt }) {
    const clip = this.clips.get(clipId);
    if (!clip) throw new Error("Clip not found");
    if (clip.status === "processing") throw new Error("This clip is still being processed, try again in a moment");
    const when = scheduleAt ? new Date(scheduleAt).getTime() : 0;
    if (scheduleAt && Number.isNaN(when)) throw new Error("Invalid schedule time");
    const created = [];
    for (const [platform, options] of Object.entries(platforms || {})) {
      if (!options || options.enabled === false) continue;
      if (!["tiktok", "instagram"].includes(platform)) continue;
      if (!this.accounts.get(platform)) throw new Error(`${platform === "tiktok" ? "TikTok" : "Instagram"} is not connected`);
      created.push({
        id: uid("p_"),
        clipId,
        clipName: clip.name,
        platform,
        caption: String(caption || "").slice(0, 2200),
        options,
        status: when > Date.now() + 15000 ? "scheduled" : "queued",
        scheduledAt: when || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        log: [],
      });
    }
    if (!created.length) throw new Error("Pick at least one platform");
    this.store.update("posts", [], (posts) => [...posts, ...created]);
    setTimeout(() => this.tick(), 50);
    return created;
  }

  cancel(id) {
    const post = this.get(id);
    if (!post) throw new Error("Post not found");
    if (!["scheduled", "queued"].includes(post.status)) throw new Error("Only waiting posts can be cancelled");
    this.store.update("posts", [], (posts) => posts.filter((p) => p.id !== id));
  }

  retry(id) {
    const post = this.get(id);
    if (!post || post.status !== "failed") throw new Error("Only failed posts can be retried");
    this.patch(id, { status: "queued", error: null, scheduledAt: null });
    setTimeout(() => this.tick(), 50);
  }

  tick() {
    const now = Date.now();
    for (const post of this.store.read("posts", [])) {
      const due = post.status === "queued" || (post.status === "scheduled" && post.scheduledAt <= now);
      if (!due || this.running.has(post.id)) continue;
      // one upload per platform at a time
      if ([...this.running].some((id) => this.get(id)?.platform === post.platform)) continue;
      this.running.add(post.id);
      this.run(post.id)
        .catch((err) => this.patch(post.id, { status: "failed", error: err.message, stage: null }))
        .finally(() => this.running.delete(post.id));
    }
  }

  async run(id) {
    const post = this.patch(id, { status: "uploading", startedAt: Date.now() });
    const clip = this.clips.get(post.clipId);
    if (!clip) throw new Error("The clip was deleted");
    const file = this.clips.filePath(clip);
    const size = fs.statSync(file).size;
    if (post.platform === "tiktok") await this.runTikTok(post, clip, file, size);
    else await this.runInstagram(post, clip, file, size);
    this.clips.markPosted(clip.id, post.platform, this.get(id));
  }

  async runTikTok(post, clip, file, size) {
    const token = await this.accounts.token("tiktok");
    const o = post.options || {};
    const mode = o.mode === "draft" ? "draft" : "direct";
    let postInfo;
    if (mode === "direct") {
      this.log(post.id, "Checking TikTok creator settings");
      const creator = await tiktok.creatorInfo(token);
      const allowed = creator.privacy_level_options || [];
      const privacy = allowed.includes(o.privacy) ? o.privacy : allowed.includes("SELF_ONLY") ? "SELF_ONLY" : allowed[0];
      if (!privacy) throw new Error("TikTok did not return any allowed privacy levels for this account");
      if (creator.max_video_post_duration_sec && clip.duration > creator.max_video_post_duration_sec) {
        throw new Error(`This clip is longer than TikTok allows for this account (${creator.max_video_post_duration_sec}s)`);
      }
      postInfo = {
        title: post.caption,
        privacy_level: privacy,
        disable_comment: !!o.disableComment || !!creator.comment_disabled,
        disable_duet: !!o.disableDuet || !!creator.duet_disabled,
        disable_stitch: !!o.disableStitch || !!creator.stitch_disabled,
        video_cover_timestamp_ms: Math.round((o.coverAt || 0) * 1000),
        brand_content_toggle: !!o.brandContent,
        brand_organic_toggle: !!o.brandOrganic,
        is_aigc: !!o.aiGenerated,
      };
      if (privacy !== o.privacy && o.privacy) this.log(post.id, `Privacy "${o.privacy}" not allowed, using ${privacy}`);
    }

    this.log(post.id, mode === "draft" ? "Starting upload to TikTok drafts" : "Starting TikTok post");
    const init = await tiktok.initPost(token, { mode, size, postInfo });
    this.patch(post.id, { remoteId: init.publish_id });
    await tiktok.uploadFile(init.upload_url, file, size, clip.mime || "video/mp4", (p) =>
      this.log(post.id, `Uploading to TikTok ${Math.round(p * 100)}%`)
    );

    this.patch(post.id, { status: "processing" });
    this.log(post.id, "TikTok is processing the video");
    const started = Date.now();
    for (;;) {
      await sleep(4000);
      const s = await tiktok.fetchStatus(token, init.publish_id);
      if (s.status === "FAILED") throw new Error(`TikTok rejected the video: ${s.fail_reason || "unknown reason"}`);
      if (s.status === "SEND_TO_USER_INBOX") {
        this.patch(post.id, { status: "published", stage: "Sent to your TikTok inbox. Open TikTok to finish posting.", inbox: true });
        return;
      }
      if (s.status === "PUBLISH_COMPLETE") {
        const videoId = s.publicaly_available_post_id?.[0];
        const username = this.accounts.get("tiktok")?.profile?.username;
        this.patch(post.id, {
          status: "published",
          stage: "Live on TikTok",
          publishedAt: Date.now(),
          remoteVideoId: videoId ? String(videoId) : null,
          url: videoId && username ? `https://www.tiktok.com/@${username}/video/${videoId}` : null,
        });
        return;
      }
      if (Date.now() - started > 15 * 60 * 1000) {
        this.patch(post.id, { status: "published", stage: "Uploaded. TikTok is still processing it, check the app." });
        return;
      }
    }
  }

  async runInstagram(post, clip, file, size) {
    const token = await this.accounts.token("instagram");
    const acc = this.accounts.get("instagram");
    const userId = acc.userId || acc.profile?.id;
    if (!userId) throw new Error("Instagram account id is missing, reconnect Instagram");
    const s = this.accounts.settings();
    const publicVideoUrl = s.publicUrl ? `${s.publicUrl}/media/${path.basename(file)}` : null;
    const result = await instagram.publishReel(s.instagram.apiVersion, token, userId, {
      file,
      size,
      caption: post.caption,
      shareToFeed: post.options?.shareToFeed !== false,
      publicVideoUrl,
      onStage: (m) => {
        if (m.startsWith("Instagram is processing")) this.patch(post.id, { status: "processing" });
        this.log(post.id, m);
      },
    });
    this.patch(post.id, {
      status: "published",
      stage: "Live on Instagram",
      publishedAt: Date.now(),
      remoteVideoId: result.mediaId,
      url: result.permalink || null,
    });
  }

  hasActive() {
    return this.store.read("posts", []).some((p) => ACTIVE.has(p.status));
  }
}
