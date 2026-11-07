// The editing engine. Everything is composited on a <canvas>: the video
// (reframed for vertical), look adjustments, captions and overlays. Export
// plays the timeline in real time and records the canvas + audio with
// MediaRecorder, so nothing ever leaves your machine while you edit.

export const ASPECTS = {
  "9:16": [1080, 1920],
  "4:5": [1080, 1350],
  "1:1": [1080, 1080],
  "16:9": [1920, 1080],
};

export const LOOKS = {
  none: { label: "Original", brightness: 100, contrast: 100, saturate: 100, grayscale: 0, sepia: 0, hue: 0, vignette: 0, chip: "#8d877d" },
  punch: { label: "Punch", brightness: 103, contrast: 118, saturate: 135, grayscale: 0, sepia: 0, hue: 0, vignette: 20, chip: "#e5624f" },
  noir: { label: "Noir", brightness: 100, contrast: 130, saturate: 100, grayscale: 100, sepia: 0, hue: 0, vignette: 40, chip: "#d9d4cb" },
  warm: { label: "Golden", brightness: 104, contrast: 106, saturate: 118, grayscale: 0, sepia: 22, hue: -6, vignette: 25, chip: "#c0954a" },
  cool: { label: "Cool", brightness: 100, contrast: 108, saturate: 92, grayscale: 0, sepia: 0, hue: 12, vignette: 15, chip: "#3987e5" },
  faded: { label: "Faded", brightness: 108, contrast: 86, saturate: 78, grayscale: 0, sepia: 8, hue: 0, vignette: 10, chip: "#a59b8a" },
};

export const TEXT_STYLES = {
  outline: { label: "Outline", sample: "Aa" },
  box: { label: "Box", sample: "Aa" },
  gold: { label: "Scannata", sample: "Aa" },
  neon: { label: "Glow", sample: "Aa" },
  clean: { label: "Clean", sample: "Aa" },
};

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function defaultProject() {
  return {
    name: "Untitled clip",
    aspect: "9:16",
    fit: "blur",
    zoom: 1,
    panX: 0,
    panY: 0,
    speed: 1,
    volume: 1,
    muted: false,
    look: { preset: "none", ...stripLook(LOOKS.none) },
    fadeIn: false,
    fadeOut: false,
    progressBar: false,
    watermark: "",
    segments: [],
    texts: [],
  };
}

function stripLook(l) {
  const { label, chip, ...rest } = l;
  return rest;
}
export const lookValues = stripLook;

const uid = () => Math.random().toString(36).slice(2, 9);
export const newId = uid;

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.4d002a,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

const easeOutBack = (x) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

const once = (el, ev, timeout = 2500) =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener(ev, finish);
      resolve();
    };
    el.addEventListener(ev, finish);
    setTimeout(finish, timeout);
  });

function luminance(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export class Engine extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.supportsFilter = typeof this.ctx.filter === "string";
    this.sources = new Map();
    this.project = defaultProject();
    this.quality = 1080;
    this.t = 0;
    this.playing = false;
    this.loop = false;
    this.cur = -1;
    this.switching = false;
    this.exporting = null;
    this.selectedText = null;
    this.showSafe = false;
    this.hit = new Map();
    this.blurA = document.createElement("canvas");
    this.blurB = document.createElement("canvas");
    this.holder = document.createElement("div");
    this.holder.style.cssText = "position:fixed;left:-10px;top:-10px;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none";
    document.body.appendChild(this.holder);
    this.resize();
    this._tick = this._tick.bind(this);
    document.fonts?.load?.('800 40px "Poppins"').catch(() => {});
    document.fonts?.load?.('40px "Abril Fatface"').catch(() => {});
    document.fonts?.ready?.then(() => this.draw());
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------------------------------------------------------- sizing ---
  dims() {
    const [w, h] = ASPECTS[this.project.aspect] || ASPECTS["9:16"];
    const scale = this.quality / Math.min(w, h);
    return [Math.round((w * scale) / 2) * 2, Math.round((h * scale) / 2) * 2];
  }

  resize() {
    const [w, h] = this.dims();
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.draw();
  }

  setQuality(q) {
    this.quality = Number(q) || 1080;
    this.resize();
  }

  // --------------------------------------------------------- sources ---
  async addSource(fileOrUrl, name) {
    const isFile = typeof fileOrUrl !== "string";
    const url = isFile ? URL.createObjectURL(fileOrUrl) : fileOrUrl;
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.src = url;
    this.holder.appendChild(video);
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error(`Can't read "${name || fileOrUrl.name}". Try MP4 (H.264) or WebM.`)), { once: true });
    });
    // Some recordings report Infinity until you seek to the end once.
    if (!Number.isFinite(video.duration)) {
      video.currentTime = 1e9;
      await once(video, "durationchange", 4000);
      video.currentTime = 0;
      await once(video, "seeked", 2000);
    }
    const src = {
      id: uid(),
      name: name || fileOrUrl.name || "Video",
      url,
      ownUrl: isFile,
      file: isFile ? fileOrUrl : null,
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      video,
      thumbs: [],
      thumbEvery: 1,
    };
    this.sources.set(src.id, src);
    if (this.ac) this._wireAudio(src);
    video.addEventListener("loadeddata", () => this.draw(), { once: true });
    this._makeThumbs(src);
    this.emit("sources");
    return src;
  }

  removeSource(id) {
    const src = this.sources.get(id);
    if (!src) return;
    src.video.pause();
    src.video.remove();
    if (src.ownUrl) URL.revokeObjectURL(src.url);
    this.sources.delete(id);
    this.emit("sources");
  }

  // Filmstrip thumbnails, taken with a separate element so playback is untouched.
  async _makeThumbs(src) {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.src = src.url;
    this.holder.appendChild(v);
    try {
      await once(v, "loadeddata", 8000);
      const count = Math.max(2, Math.min(48, Math.ceil(src.duration / 1.5)));
      src.thumbEvery = src.duration / count;
      const c = document.createElement("canvas");
      const h = 72;
      c.height = h;
      c.width = Math.max(32, Math.round((h * (src.width || 16)) / (src.height || 9)));
      const cx = c.getContext("2d");
      for (let i = 0; i < count; i++) {
        if (!this.sources.has(src.id)) break;
        v.currentTime = Math.min(src.duration - 0.05, (i + 0.5) * src.thumbEvery);
        await once(v, "seeked", 3000);
        cx.drawImage(v, 0, 0, c.width, c.height);
        src.thumbs[i] = c.toDataURL("image/jpeg", 0.6);
        if (i === 0 || i % 6 === 5 || i === count - 1) this.emit("thumbs", src.id);
      }
    } catch {
      /* thumbnails are cosmetic */
    } finally {
      v.removeAttribute("src");
      v.load();
      v.remove();
    }
  }

  // ----------------------------------------------------------- audio ---
  ensureAudio() {
    if (!this.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.fade = this.ac.createGain();
      this.monitor = this.ac.createGain();
      this.recDest = this.ac.createMediaStreamDestination();
      this.master.connect(this.fade);
      this.fade.connect(this.monitor);
      this.monitor.connect(this.ac.destination);
      this.fade.connect(this.recDest);
      for (const src of this.sources.values()) this._wireAudio(src);
    }
    this.applyAudio();
    if (this.ac.state === "suspended") this.ac.resume();
  }

  _wireAudio(src) {
    if (src.node) return;
    try {
      src.node = this.ac.createMediaElementSource(src.video);
      src.node.connect(this.master);
    } catch {
      /* already wired */
    }
  }

  applyAudio() {
    if (!this.master) return;
    const p = this.project;
    this.master.gain.value = p.muted ? 0 : p.volume;
  }

  // -------------------------------------------------------- timeline ---
  layout() {
    let start = 0;
    const speed = this.project.speed || 1;
    return this.project.segments.map((s, index) => {
      const dur = Math.max(0, (s.out - s.in) / speed);
      const item = { ...s, index, start, end: start + dur, dur };
      start += dur;
      return item;
    });
  }

  get duration() {
    const l = this.layout();
    return l.length ? l[l.length - 1].end : 0;
  }

  locate(t, layout = this.layout()) {
    if (!layout.length) return null;
    const speed = this.project.speed || 1;
    for (const seg of layout) {
      if (t < seg.end || seg.index === layout.length - 1) {
        const local = Math.min(Math.max(0, t - seg.start), seg.dur);
        return { seg, index: seg.index, srcTime: seg.in + local * speed };
      }
    }
    return null;
  }

  // ------------------------------------------------------- transport ---
  async _activate(index, srcTime) {
    const layout = this.layout();
    const seg = layout[index];
    if (!seg) return null;
    const src = this.sources.get(seg.src);
    if (!src) return null;
    for (const s of this.sources.values()) if (s !== src && !s.video.paused) s.video.pause();
    this.cur = index;
    const v = src.video;
    if (Math.abs(v.currentTime - srcTime) > 0.04) {
      v.currentTime = srcTime;
      await once(v, "seeked", 2500);
    }
    return { seg, src, v };
  }

  async seek(t) {
    const total = this.duration;
    this.t = Math.max(0, Math.min(t, total));
    const wasPlaying = this.playing;
    if (wasPlaying) this._pauseVideos();
    const loc = this.locate(this.t);
    this.emit("time", this.t);
    if (!loc) return this.draw();
    const token = (this._seekToken = (this._seekToken || 0) + 1);
    await this._activate(loc.index, loc.srcTime);
    if (token !== this._seekToken) return;
    this.draw();
    if (wasPlaying && this.playing) this._startVideo();
  }

  _pauseVideos() {
    for (const s of this.sources.values()) if (!s.video.paused) s.video.pause();
  }

  async _startVideo() {
    const seg = this.layout()[this.cur];
    const src = seg && this.sources.get(seg.src);
    if (!src) return;
    src.video.playbackRate = this.project.speed || 1;
    try {
      await src.video.play();
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    }
  }

  async play() {
    if (!this.project.segments.length || this.playing) return;
    this.ensureAudio();
    if (this.t >= this.duration - 0.05) this.t = 0;
    const loc = this.locate(this.t);
    await this._activate(loc.index, loc.srcTime);
    this.playing = true;
    this.emit("state");
    try {
      await this._startVideo();
    } catch (err) {
      this.playing = false;
      this.emit("state");
      throw err;
    }
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this._tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._pauseVideos();
    cancelAnimationFrame(this.raf);
    this.draw();
    this.emit("state");
  }

  toggle() {
    return this.playing ? this.pause() : this.play();
  }

  async _tick() {
    if (!this.playing) return;
    this.raf = requestAnimationFrame(this._tick);
    if (this.switching) return;
    const layout = this.layout();
    const seg = layout[this.cur];
    if (!seg) return this.pause();
    const src = this.sources.get(seg.src);
    const v = src.video;
    const speed = this.project.speed || 1;
    this.t = seg.start + Math.max(0, v.currentTime - seg.in) / speed;

    if (v.currentTime >= seg.out - 0.002 || v.ended) {
      const next = layout[this.cur + 1];
      if (!next) {
        this.t = seg.end;
        this.draw();
        this.emit("time", this.t);
        if (this.exporting) return this._endExport();
        if (this.loop) {
          this.switching = true;
          v.pause();
          await this._activate(0, layout[0].in);
          this.t = 0;
          await this._startVideo();
          this.switching = false;
          return;
        }
        return this.pause();
      }
      if (next.src === seg.src && Math.abs(next.in - seg.out) < 0.05) {
        // contiguous cut of the same video: keep rolling
        this.cur++;
      } else {
        this.switching = true;
        v.pause();
        this.exporting?.rec.state === "recording" && this.exporting.rec.pause();
        await this._activate(next.index, next.in);
        this.t = next.start;
        this.draw();
        if (this.playing) await this._startVideo();
        this.exporting?.rec.state === "paused" && this.exporting.rec.resume();
        this.switching = false;
      }
    }
    this._applyFadeAudio();
    this.draw();
    this.emit("time", this.t);
    if (this.exporting) this._exportProgress();
  }

  _applyFadeAudio() {
    if (!this.fade) return;
    const p = this.project;
    const total = this.duration;
    let g = 1;
    if (p.fadeIn && this.t < 0.5) g = Math.min(g, this.t / 0.5);
    if (p.fadeOut && total - this.t < 0.6) g = Math.min(g, Math.max(0, (total - this.t) / 0.6));
    this.fade.gain.value = g;
  }

  // --------------------------------------------------------- drawing ---
  filterString() {
    const l = this.project.look;
    const parts = [];
    if (l.brightness !== 100) parts.push(`brightness(${l.brightness}%)`);
    if (l.contrast !== 100) parts.push(`contrast(${l.contrast}%)`);
    if (l.saturate !== 100) parts.push(`saturate(${l.saturate}%)`);
    if (l.grayscale) parts.push(`grayscale(${l.grayscale}%)`);
    if (l.sepia) parts.push(`sepia(${l.sepia}%)`);
    if (l.hue) parts.push(`hue-rotate(${l.hue}deg)`);
    return parts.join(" ") || "none";
  }

  // Video rectangle on the canvas for the current framing.
  videoRect(src) {
    const { width: W, height: H } = this.canvas;
    const p = this.project;
    const vw = src.video.videoWidth || src.width || 16;
    const vh = src.video.videoHeight || src.height || 9;
    const base = p.fit === "fill" ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
    const s = base * (p.zoom || 1);
    const dw = vw * s;
    const dh = vh * s;
    return { x: (W - dw) / 2 + p.panX * W, y: (H - dh) / 2 + p.panY * H, w: dw, h: dh };
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const p = this.project;
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    const loc = this.locate(this.t);
    const src = loc && this.sources.get(loc.seg.src);
    const v = src?.video;
    if (v && v.readyState >= 2) {
      const filter = this.supportsFilter ? this.filterString() : "none";
      if (p.fit === "blur") this._drawBlurBackground(v, W, H, filter);
      const r = this.videoRect(src);
      if (this.supportsFilter) ctx.filter = filter;
      ctx.drawImage(v, r.x, r.y, r.w, r.h);
      ctx.filter = "none";
    }

    if (p.look.vignette) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${(p.look.vignette / 100) * 0.85})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    this.hit.clear();
    for (const layer of p.texts) {
      if (this.t >= layer.start && this.t < layer.end) this._drawText(layer, W, H);
    }

    if (p.watermark) {
      const px = Math.round(W * 0.03);
      ctx.font = `600 ${px}px Poppins, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = px * 0.4;
      ctx.fillText(p.watermark, W - W * 0.05, H * (W < H ? 0.085 : 0.06));
      ctx.shadowBlur = 0;
    }

    const total = this.duration;
    if (p.progressBar && total > 0) {
      const bh = Math.max(4, Math.round(H * 0.006));
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(0, H - bh, W, bh);
      ctx.fillStyle = "#c0954a";
      ctx.fillRect(0, H - bh, (W * this.t) / total, bh);
    }

    let fadeA = 0;
    if (p.fadeIn && this.t < 0.5) fadeA = 1 - this.t / 0.5;
    if (p.fadeOut && total && total - this.t < 0.6) fadeA = Math.max(fadeA, 1 - (total - this.t) / 0.6);
    if (fadeA > 0) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(1, fadeA)})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (!this.exporting && !this.exportPrep) this._drawGuides(W, H);
    ctx.restore();
  }

  // Cheap, fast blur that works everywhere: shrink a lot, then scale back up.
  _drawBlurBackground(v, W, H, filter) {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const s = Math.max(W / vw, H / vh);
    const sw = W / s;
    const sh = H / s;
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;
    const a = this.blurA;
    const b = this.blurB;
    a.width = 18;
    a.height = Math.max(2, Math.round((18 * H) / W));
    b.width = 72;
    b.height = Math.max(2, Math.round((72 * H) / W));
    const ac = a.getContext("2d");
    const bc = b.getContext("2d");
    ac.imageSmoothingQuality = "high";
    ac.drawImage(v, sx, sy, sw, sh, 0, 0, a.width, a.height);
    bc.imageSmoothingQuality = "high";
    bc.drawImage(a, 0, 0, b.width, b.height);
    const { ctx } = this;
    ctx.imageSmoothingQuality = "high";
    if (this.supportsFilter) ctx.filter = filter;
    ctx.drawImage(b, 0, 0, W, H);
    ctx.filter = "none";
    ctx.fillStyle = "rgba(0,0,0,0.38)";
    ctx.fillRect(0, 0, W, H);
  }

  _wrap(text, maxW) {
    const { ctx } = this;
    const out = [];
    for (const para of text.split("\n")) {
      const words = para.split(/\s+/).filter(Boolean);
      let line = "";
      for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (ctx.measureText(test).width > maxW && line) {
          out.push(line);
          line = w;
        } else line = test;
      }
      out.push(line);
    }
    return out;
  }

  _drawText(layer, W, H) {
    const { ctx } = this;
    const text = layer.upper ? layer.text.toUpperCase() : layer.text;
    if (!text.trim()) return;
    const px = Math.max(8, (layer.size / 100) * W);
    const style = layer.style || "outline";
    const font =
      style === "gold"
        ? `${px * 1.08}px "Abril Fatface", Georgia, serif`
        : `${style === "clean" || style === "box" ? 700 : 800} ${px}px Poppins, sans-serif`;
    ctx.font = font;
    const lines = this._wrap(text, W * 0.84);
    const lh = px * (style === "box" ? 1.42 : 1.18);
    const widths = lines.map((l) => ctx.measureText(l).width);
    const maxW = Math.max(...widths);
    const totalH = lh * lines.length;
    const cx = layer.x * W;
    const cy = layer.y * H;

    // entrance / exit animation
    const since = this.t - layer.start;
    const until = layer.end - this.t;
    let alpha = 1;
    let scale = 1;
    let offY = 0;
    if (layer.anim === "pop") {
      const k = Math.min(1, since / 0.22);
      scale = 0.72 + 0.28 * easeOutBack(k);
      alpha = Math.min(1, since / 0.08);
    } else if (layer.anim === "fade") {
      alpha = Math.min(1, since / 0.25, until / 0.2);
    } else if (layer.anim === "rise") {
      const k = Math.min(1, since / 0.3);
      alpha = k;
      offY = (1 - easeOutBack(k)) * px * 0.6;
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(cx, cy + offY);
    ctx.scale(scale, scale);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    lines.forEach((line, i) => {
      const y = -totalH / 2 + lh * (i + 0.5);
      if (style === "outline") {
        ctx.lineWidth = px * 0.17;
        ctx.strokeStyle = "#000";
        ctx.strokeText(line, 0, y);
        ctx.fillStyle = layer.color;
        ctx.fillText(line, 0, y);
      } else if (style === "box") {
        const w = widths[i] + px * 0.6;
        const h = px * 1.3;
        ctx.fillStyle = layer.color;
        roundRect(ctx, -w / 2, y - h / 2, w, h, px * 0.22);
        ctx.fill();
        ctx.fillStyle = luminance(layer.color) > 0.55 ? "#0c0b0a" : "#ffffff";
        ctx.fillText(line, 0, y + px * 0.04);
      } else if (style === "gold") {
        const g = ctx.createLinearGradient(0, y - px / 2, 0, y + px / 2);
        g.addColorStop(0, "#f6dc9e");
        g.addColorStop(0.55, "#c99a4c");
        g.addColorStop(1, "#8f6526");
        ctx.shadowColor = "rgba(0,0,0,0.65)";
        ctx.shadowBlur = px * 0.25;
        ctx.shadowOffsetY = px * 0.06;
        ctx.fillStyle = layer.color.toLowerCase() === "#ffffff" || layer.color.toLowerCase() === "#c0954a" ? g : layer.color;
        ctx.fillText(line, 0, y);
        ctx.shadowColor = "transparent";
      } else if (style === "neon") {
        ctx.shadowColor = layer.color;
        ctx.shadowBlur = px * 0.55;
        ctx.fillStyle = layer.color;
        ctx.fillText(line, 0, y);
        ctx.fillText(line, 0, y);
        ctx.shadowBlur = 0;
        ctx.globalAlpha *= 0.7;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(line, 0, y);
        ctx.globalAlpha = Math.max(0, alpha);
      } else {
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = px * 0.3;
        ctx.shadowOffsetY = px * 0.06;
        ctx.fillStyle = layer.color;
        ctx.fillText(line, 0, y);
        ctx.shadowColor = "transparent";
      }
    });
    ctx.restore();

    const pad = px * 0.4;
    const box = { x: cx - maxW / 2 - pad, y: cy - totalH / 2 - pad, w: maxW + pad * 2, h: totalH + pad * 2 };
    this.hit.set(layer.id, box);

    if (!this.exporting && !this.exportPrep && this.selectedText === layer.id) {
      ctx.save();
      ctx.strokeStyle = "#c0954a";
      ctx.lineWidth = Math.max(2, W * 0.002);
      ctx.setLineDash([W * 0.012, W * 0.008]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.restore();
    }
  }

  // Where TikTok / Reels put their buttons and captions (preview only).
  _drawGuides(W, H) {
    if (!this.showSafe || W >= H) return;
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = "rgba(229, 98, 79, 0.16)";
    ctx.strokeStyle = "rgba(229, 98, 79, 0.55)";
    ctx.lineWidth = 2;
    const rects = [
      [0, 0, W, H * 0.08],
      [W * 0.84, H * 0.42, W * 0.16, H * 0.4],
      [0, H * 0.8, W, H * 0.2],
    ];
    for (const r of rects) {
      ctx.fillRect(...r);
      ctx.strokeRect(...r);
    }
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `600 ${W * 0.024}px Poppins, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("app UI · keep text out of red", W / 2, H * 0.9);
    ctx.restore();
  }

  hitText(x, y) {
    const ids = [...this.hit.keys()].reverse();
    for (const id of ids) {
      const b = this.hit.get(id);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return id;
    }
    return null;
  }

  // ---------------------------------------------------------- export ---
  async exportVideo({ fps = 30, bitrate = 10, onProgress, onThumb } = {}) {
    if (!this.project.segments.length) throw new Error("Add a video to the timeline first");
    const mimeType = pickMime();
    if (mimeType === null) throw new Error("This browser can't record video. Use Chrome, Edge, Firefox or Safari 14.1+.");
    if (typeof this.canvas.captureStream !== "function") throw new Error("This browser can't capture the canvas. Use Chrome, Edge or Firefox.");
    this.pause();
    this.ensureAudio();
    const prevSel = this.selectedText;
    this.selectedText = null;
    this.exportPrep = true;
    // Paint a clean first frame (no editor guides) before the stream starts.
    this.monitor.gain.value = 0; // render silently
    this.t = 0;
    const first = this.layout()[0];
    await this._activate(0, first.in);
    this._applyFadeAudio();
    this.draw();
    this.exportPrep = false;

    const stream = this.canvas.captureStream(fps);
    const tracks = [...stream.getVideoTracks(), ...this.recDest.stream.getAudioTracks()];
    const rec = new MediaRecorder(new MediaStream(tracks), {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: Math.round(bitrate * 1e6),
      audioBitsPerSecond: 192000,
    });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const total = this.duration;
    const result = new Promise((resolve, reject) => {
      this.exporting = { rec, total, onProgress, onThumb, thumbTaken: false, resolve, reject, cancelled: false };
      rec.onstop = () => {
        const ex = this.exporting;
        this.exporting = null;
        this.selectedText = prevSel;
        this.monitor.gain.value = 1;
        stream.getTracks().forEach((t) => t.stop());
        if (ex?.cancelled) return reject(Object.assign(new Error("Export cancelled"), { cancelled: true }));
        const type = (rec.mimeType || mimeType || "video/webm").split(";")[0];
        resolve(new Blob(chunks, { type }));
      };
      rec.onerror = (e) => reject(e.error || new Error("Recording failed"));
    });

    this.draw();
    rec.start(500);
    this.playing = true;
    this.emit("state");
    await this._startVideo();
    this.raf = requestAnimationFrame(this._tick);
    return result;
  }

  _exportProgress() {
    const ex = this.exporting;
    ex.onProgress?.(Math.min(1, this.t / ex.total), this.t);
    if (!ex.thumbTaken && this.t >= Math.min(1, ex.total / 2)) {
      ex.thumbTaken = true;
      const c = document.createElement("canvas");
      c.width = 360;
      c.height = Math.round((360 * this.canvas.height) / this.canvas.width);
      c.getContext("2d").drawImage(this.canvas, 0, 0, c.width, c.height);
      c.toBlob((b) => ex.onThumb?.(b), "image/jpeg", 0.82);
    }
  }

  _endExport() {
    const ex = this.exporting;
    if (!ex || ex.ending) return;
    ex.ending = true;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    ex.onProgress?.(1, ex.total);
    // let the last frames flush
    setTimeout(() => {
      this._pauseVideos();
      if (ex.rec.state !== "inactive") ex.rec.stop();
      this.emit("state");
    }, 250);
  }

  cancelExport() {
    const ex = this.exporting;
    if (!ex) return;
    ex.cancelled = true;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this._pauseVideos();
    if (ex.rec.state !== "inactive") ex.rec.stop();
    this.emit("state");
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
