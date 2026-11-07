// LIBRARY: every finished clip, ready to post.
import { listClips, saveClip, renameClip, deleteClip, server, on } from "../api.js";
import { esc, icon, $, $$, duration, bytes, ago, toast, toastError, confirmDialog, promptDialog, download, isVideoFile, PLATFORMS } from "../ui.js";

let root;
let app;
let clips = [];
let filter = "all";
let query = "";

export function clipCard(c, { selectable = false, selected = false, actions = true } = {}) {
  const posted = Object.keys(c.posted || {});
  return `<div class="clip-card ${selected ? "selected" : ""}" data-clip="${c.id}">
    <div class="clip-thumb">
      <div class="ph">${icon("film")}</div>
      ${c.thumbUrl ? `<img src="${c.thumbUrl}" alt="" loading="lazy" style="position:relative">` : ""}
      <video muted loop playsinline preload="none" data-src="${c.url}"></video>
      ${posted.length ? `<div class="tags">${posted.map((p) => `<span title="Posted to ${PLATFORMS[p]?.name}">${icon(PLATFORMS[p]?.icon || "check")}</span>`).join("")}</div>` : ""}
      <span class="dur num">${duration(c.duration)}</span>
      ${selectable ? `<span class="check-sel">${icon("check")}</span>` : ""}
    </div>
    <div class="clip-meta">
      <div class="clip-name" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="clip-sub">${ago(c.createdAt)} · ${bytes(c.size)}${c.status === "processing" ? " · converting" : ""}${c.local ? " · this tab only" : ""}</div>
      ${
        actions
          ? `<div class="clip-actions">
        ${server.online ? `<button class="icon-btn" data-do="post" title="Post">${icon("publish")}</button>` : ""}
        <button class="icon-btn" data-do="edit" title="Open in Studio">${icon("studio")}</button>
        <button class="icon-btn" data-do="download" title="Download">${icon("download")}</button>
        <button class="icon-btn" data-do="rename" title="Rename">${icon("text")}</button>
        <span class="spacer"></span>
        <button class="icon-btn" data-do="delete" title="Delete">${icon("trash")}</button>
      </div>`
          : ""
      }
    </div>
  </div>`;
}

// hover-to-preview on any clip grid
export function wireHoverPreview(container) {
  container.addEventListener("pointerover", (e) => {
    const card = e.target.closest(".clip-card");
    if (!card || card._hovering) return;
    card._hovering = true;
    const v = card.querySelector("video");
    if (!v) return;
    if (!v.src) v.src = v.dataset.src;
    v.oncanplay = () => v.classList.add("ready");
    v.play().catch(() => {});
  });
  container.addEventListener("pointerout", (e) => {
    const card = e.target.closest(".clip-card");
    if (!card || card.contains(e.relatedTarget)) return;
    card._hovering = false;
    const v = card.querySelector("video");
    if (v) {
      v.pause();
      v.classList.remove("ready");
    }
  });
}

function render() {
  const q = query.toLowerCase();
  const list = clips.filter((c) => {
    const posted = Object.keys(c.posted || {}).length > 0;
    if (filter === "posted" && !posted) return false;
    if (filter === "fresh" && posted) return false;
    return !q || c.name.toLowerCase().includes(q);
  });
  const grid = $("#libGrid", root);
  $("#libCount", root).textContent = `${clips.length} clip${clips.length === 1 ? "" : "s"}`;
  if (!clips.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Your library is empty</h3>
      <p>Clips you export from the Studio land here. You can also drop finished videos on this page.</p>
      <a class="btn primary" href="#/studio">${icon("studio")}Open the Studio</a></div>`;
    return;
  }
  grid.innerHTML = list.length ? list.map((c) => clipCard(c)).join("") : `<div class="empty" style="grid-column:1/-1">Nothing matches.</div>`;
}

async function load() {
  try {
    clips = await listClips();
  } catch (err) {
    toastError(err, "Couldn't load the library");
    clips = [];
  }
  render();
}

// Read duration + a poster frame from a local video file before uploading.
function probe(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    const url = URL.createObjectURL(file);
    v.src = url;
    const done = (meta) => {
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    v.onloadeddata = () => {
      v.currentTime = Math.min(1, (v.duration || 2) / 2);
    };
    v.onseeked = () => {
      const c = document.createElement("canvas");
      c.width = 360;
      c.height = Math.round((360 * v.videoHeight) / v.videoWidth) || 640;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((thumbBlob) => done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight, thumbBlob }), "image/jpeg", 0.82);
    };
    v.onerror = () => done({});
    setTimeout(() => done({}), 8000);
  });
}

async function uploadFiles(files) {
  const list = [...files].filter(isVideoFile);
  if (!list.length) return toast("No videos found", { type: "err" });
  for (const file of list) {
    const close = toast(`Adding ${file.name}`, { sub: "Uploading to your library…", timeout: 0 });
    try {
      const meta = await probe(file);
      await saveClip(file, { name: file.name, ...meta, duration: meta.duration?.toFixed?.(2), source: "upload" });
      toast("Added to library", { sub: file.name, type: "ok" });
    } catch (err) {
      toastError(err, "Upload failed");
    } finally {
      close();
    }
  }
}

export default {
  mount(section, ctx) {
    app = ctx;
    root = section;
    section.innerHTML = `
      <div class="page-head">
        <div><span class="eyebrow">Library</span><h1 class="page-title">Your clips</h1></div>
        <div class="row">
          <label class="btn">${icon("upload")}Add finished video<input type="file" accept="video/*" multiple hidden id="libUpload"></label>
          <a class="btn primary" href="#/studio">${icon("studio")}New clip</a>
        </div>
      </div>
      <div class="toolbar">
        <div class="pills" id="libPills">
          <button class="pill on" data-f="all">All</button>
          <button class="pill" data-f="fresh">Not posted</button>
          <button class="pill" data-f="posted">Posted</button>
        </div>
        <span class="spacer"></span>
        <span class="muted" style="font-size:12px" id="libCount"></span>
        <input class="input" id="libSearch" placeholder="Search clips" style="width:220px;height:36px">
      </div>
      <div class="lib-grid" id="libGrid"></div>`;

    $("#libUpload", root).addEventListener("change", (e) => {
      uploadFiles(e.target.files);
      e.target.value = "";
    });
    $("#libPills", root).addEventListener("click", (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      filter = b.dataset.f;
      $$("#libPills .pill", root).forEach((x) => x.classList.toggle("on", x === b));
      render();
    });
    $("#libSearch", root).addEventListener("input", (e) => {
      query = e.target.value;
      render();
    });
    const grid = $("#libGrid", root);
    wireHoverPreview(grid);
    grid.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-do]");
      const card = e.target.closest("[data-clip]");
      if (!btn || !card) return;
      const clip = clips.find((c) => c.id === card.dataset.clip);
      if (!clip) return;
      const what = btn.dataset.do;
      try {
        if (what === "post") app.navigate(`publish?clip=${clip.id}`);
        if (what === "edit") {
          const studio = await app.getView("studio");
          app.navigate("studio");
          studio.openClip(clip);
        }
        if (what === "download") download(clip.url, `${clip.name}.${(clip.mime || "").includes("webm") ? "webm" : "mp4"}`);
        if (what === "rename") {
          const name = await promptDialog("Rename clip", clip.name);
          if (name) await renameClip(clip.id, name);
        }
        if (what === "delete") {
          if (await confirmDialog("Delete this clip?", `"${clip.name}" will be removed from your library. Posts already on TikTok or Instagram stay up.`, { ok: "Delete", danger: true })) {
            await deleteClip(clip.id);
            toast("Clip deleted");
          }
        }
      } catch (err) {
        toastError(err);
      }
    });
    on("clips:changed", () => root.isConnected && load());
  },
  async show() {
    await load();
    // pick up background MP4 conversions
    clearInterval(this._poll);
    this._poll = setInterval(() => clips.some((c) => c.status === "processing") && load(), 3000);
  },
  hide() {
    clearInterval(this._poll);
  },
  uploadFiles,
};
