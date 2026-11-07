// Pulls performance numbers from every connected platform and normalises them
// into one shape. Also keeps a daily snapshot so follower growth can be charted.
import * as tiktok from "./tiktok.js";
import * as instagram from "./instagram.js";

const CACHE_MS = 3 * 60 * 1000;

export class Stats {
  constructor(store, accounts) {
    this.store = store;
    this.accounts = accounts;
    this.cache = null;
    this.inflight = null;
  }

  async get({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.collect()
      .then((data) => {
        this.cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async collect() {
    const connected = this.accounts.all();
    const out = { generatedAt: Date.now(), accounts: [], posts: [], errors: {}, history: [] };
    const jobs = [];
    if (connected.tiktok) jobs.push(this.collectTikTok(out).catch((e) => (out.errors.tiktok = e.message)));
    if (connected.instagram) jobs.push(this.collectInstagram(out).catch((e) => (out.errors.instagram = e.message)));
    await Promise.all(jobs);
    this.snapshot(out);
    out.history = this.store.read("history", []);
    return out;
  }

  async collectTikTok(out) {
    const token = await this.accounts.token("tiktok");
    const profile = await this.accounts.loadProfile("tiktok");
    this.accounts.set("tiktok", { ...this.accounts.get("tiktok"), profile, lastError: null });
    out.accounts.push({ platform: "tiktok", ...profile });
    const videos = await tiktok.listVideos(token, 60);
    for (const v of videos) {
      out.posts.push({
        platform: "tiktok",
        id: String(v.id),
        title: v.title || v.video_description || "Untitled",
        cover: v.cover_image_url || "",
        url: v.share_url || "",
        createdAt: (v.create_time || 0) * 1000,
        duration: v.duration || null,
        views: v.view_count ?? 0,
        likes: v.like_count ?? 0,
        comments: v.comment_count ?? 0,
        shares: v.share_count ?? 0,
      });
    }
  }

  async collectInstagram(out) {
    const token = await this.accounts.token("instagram");
    const version = this.accounts.settings().instagram.apiVersion;
    const profile = await this.accounts.loadProfile("instagram");
    this.accounts.set("instagram", { ...this.accounts.get("instagram"), profile, lastError: null });
    out.accounts.push({ platform: "instagram", ...profile });
    const media = (await instagram.listMedia(version, token, 50)).filter(
      (m) => m.media_type === "VIDEO" || m.media_product_type === "REELS"
    );
    // Insights are one request per post; keep it bounded and parallel-ish.
    const insights = await Promise.all(media.slice(0, 30).map((m) => instagram.mediaInsights(version, token, m.id)));
    media.forEach((m, i) => {
      const ins = insights[i] || {};
      out.posts.push({
        platform: "instagram",
        id: String(m.id),
        title: (m.caption || "Untitled").split("\n")[0].slice(0, 140),
        cover: m.thumbnail_url || m.media_url || "",
        url: m.permalink || "",
        createdAt: Date.parse(m.timestamp) || 0,
        views: ins.views ?? ins.reach ?? 0,
        reach: ins.reach ?? null,
        likes: m.like_count ?? ins.likes ?? 0,
        comments: m.comments_count ?? ins.comments ?? 0,
        shares: ins.shares ?? 0,
        saves: ins.saved ?? 0,
      });
    });
  }

  snapshot(out) {
    if (!out.accounts.length) return;
    const day = new Date().toISOString().slice(0, 10);
    this.store.update("history", [], (history) => {
      const entry = { day };
      for (const a of out.accounts) {
        const posts = out.posts.filter((p) => p.platform === a.platform);
        entry[a.platform] = {
          followers: a.followers ?? null,
          views: posts.reduce((s, p) => s + (p.views || 0), 0),
          likes: posts.reduce((s, p) => s + (p.likes || 0), 0),
        };
      }
      const rest = history.filter((h) => h.day !== day);
      const prev = history.find((h) => h.day === day) || {};
      return [...rest, { ...prev, ...entry }].sort((a, b) => a.day.localeCompare(b.day)).slice(-365);
    });
  }

  invalidate() {
    this.cache = null;
  }
}
