// Clip library: finished videos saved from the studio (or uploaded directly).
import fs from "node:fs";
import path from "node:path";
import { uid } from "./store.js";
import { detectFfmpeg, normalizeToMp4, makeThumbnail } from "./media.js";

const EXT_BY_MIME = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-m4v": "m4v" };

export class Clips {
  constructor(store) {
    this.store = store;
    // Clips stuck in "processing" from a previous run are usable as-is.
    this.store.update("clips", [], (clips) => clips.map((c) => (c.status === "processing" ? { ...c, status: "ready" } : c)));
  }

  list() {
    return this.store
      .read("clips", [])
      .filter((c) => fs.existsSync(this.filePath(c)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    return this.store.read("clips", []).find((c) => c.id === id) || null;
  }

  filePath(clip) {
    return path.join(this.store.mediaDir, clip.file);
  }

  patch(id, fields) {
    let out = null;
    this.store.update("clips", [], (clips) => clips.map((c) => (c.id === id ? (out = { ...c, ...fields }) : c)));
    return out;
  }

  extFor(mime, name) {
    const base = (mime || "").split(";")[0].trim().toLowerCase();
    if (EXT_BY_MIME[base]) return EXT_BY_MIME[base];
    const fromName = path.extname(name || "").slice(1).toLowerCase();
    return ["mp4", "webm", "mov", "m4v"].includes(fromName) ? fromName : "mp4";
  }

  // `tmpFile` was streamed to disk by the HTTP layer.
  async add({ tmpFile, size, name, mime, duration, width, height, source }) {
    const id = uid("c_");
    const ext = this.extFor(mime, name);
    const file = `${id}.${ext}`;
    fs.renameSync(tmpFile, path.join(this.store.mediaDir, file));
    const clip = {
      id,
      name: (name || "Untitled clip").replace(/\.[a-z0-9]+$/i, "").slice(0, 120),
      file,
      mime: ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4",
      size,
      duration: Number(duration) || null,
      width: Number(width) || null,
      height: Number(height) || null,
      source: source || "studio",
      createdAt: Date.now(),
      status: "ready",
      thumb: null,
      posted: {},
    };
    const ffmpeg = await detectFfmpeg();
    if (ffmpeg) clip.status = "processing";
    this.store.update("clips", [], (clips) => [...clips, clip]);
    if (ffmpeg) this.finish(clip).catch((err) => console.warn("[clips] post-processing failed:", err.message));
    return clip;
  }

  // Re-encode to a platform-friendly MP4 and grab a thumbnail if none was sent.
  async finish(clip) {
    const input = this.filePath(clip);
    const outName = `${clip.id}.final.mp4`;
    const output = path.join(this.store.mediaDir, outName);
    try {
      await normalizeToMp4(input, output);
      fs.rmSync(input, { force: true });
      const size = fs.statSync(output).size;
      this.patch(clip.id, { file: outName, mime: "video/mp4", size, status: "ready", normalized: true });
    } catch (err) {
      fs.rmSync(output, { force: true });
      this.patch(clip.id, { status: "ready", normalizeError: err.message });
    }
    const current = this.get(clip.id);
    if (current && !current.thumb) {
      const thumb = `${clip.id}.jpg`;
      if (await makeThumbnail(this.filePath(current), path.join(this.store.mediaDir, thumb), Math.min(1, (current.duration || 2) / 2))) {
        this.patch(clip.id, { thumb });
      }
    }
  }

  saveThumb(id, buffer) {
    const clip = this.get(id);
    if (!clip) return null;
    const thumb = `${id}.jpg`;
    fs.writeFileSync(path.join(this.store.mediaDir, thumb), buffer);
    return this.patch(id, { thumb });
  }

  rename(id, name) {
    return this.patch(id, { name: String(name || "").slice(0, 120) || "Untitled clip" });
  }

  markPosted(id, platform, post) {
    const clip = this.get(id);
    if (!clip) return;
    this.patch(id, {
      posted: { ...(clip.posted || {}), [platform]: { at: Date.now(), url: post?.url || null, postId: post?.id } },
    });
  }

  remove(id) {
    const clip = this.get(id);
    if (!clip) return false;
    fs.rmSync(this.filePath(clip), { force: true });
    if (clip.thumb) fs.rmSync(path.join(this.store.mediaDir, clip.thumb), { force: true });
    this.store.update("clips", [], (clips) => clips.filter((c) => c.id !== id));
    return true;
  }
}
