// STUDIO: import, cut, reframe, caption, export.
import { Engine, ASPECTS, LOOKS, TEXT_STYLES, SPEEDS, defaultProject, lookValues, newId, pickMime } from "../engine.js";
import { esc, icon, $, $$, timecode, duration, toast, toastError, modal, paintRanges, isVideoFile, download, bytes } from "../ui.js";
import { saveClip, prefs, setPrefs, server } from "../api.js";

let root;
let app;
let engine;
let tab = "clip";
let selSeg = null;
let pps = 40;
let ppsAuto = true;
let history = [];
let future = [];
let lastCommit = { key: null, at: 0 };
let dirty = false;
let visible = false;
let rafPending = false;

const COLORS = ["#ffffff", "#0c0b0a", "#c0954a", "#ffd400", "#ff3b5c", "#25f4ee", "#8bff5a"];

// ============================================================== layout ===
const TEMPLATE = () => `
<div class="studio">
  <div class="studio-bar">
    <input class="project-name" id="projName" value="Untitled clip" aria-label="Clip name" spellcheck="false">
    <span class="spacer"></span>
    <button class="icon-btn" id="undoBtn" title="Undo (Ctrl+Z)" disabled>${icon("undo")}</button>
    <button class="icon-btn" id="redoBtn" title="Redo (Ctrl+Shift+Z)" disabled>${icon("redo")}</button>
    <span class="bar-sep"></span>
    <button class="btn ghost sm" id="keysBtn" title="Keyboard shortcuts">?</button>
    <button class="btn ghost sm" id="newBtn">${icon("plus")}New</button>
    <button class="btn primary sm" id="exportBtn">${icon("download")}Export</button>
  </div>

  <aside class="studio-bin">
    <label class="dropzone" id="binDrop">
      <div class="dz-icon">${icon("upload")}</div>
      <strong>Import video</strong>
      <span>Drop here or click</span>
      <input type="file" accept="video/*,.mkv" multiple>
    </label>
    <div class="panel-title">Media <span id="binCount" class="muted"></span></div>
    <div class="bin-list" id="binList"></div>
    <p class="studio-foot-note">Your source videos never leave this computer. Only the finished clip is saved to your library.</p>
  </aside>

  <div class="studio-stage">
    <div class="stage-wrap" id="stageWrap">
      <canvas class="stage-canvas" id="stageCanvas"></canvas>
      <div class="stage-empty" id="stageEmpty">
        <label class="dropzone">
          <div class="dz-icon">${icon("upload")}</div>
          <strong>Drop a video to start clipping</strong>
          <span>Podcasts, streams, long-form. Cut the best part, frame it vertical, caption it.</span>
          <input type="file" accept="video/*,.mkv" multiple>
        </label>
      </div>
    </div>
    <div class="transport">
      <button class="icon-btn" id="toStart" title="Go to start (Home)">${icon("back")}</button>
      <button class="play-btn" id="playBtn" title="Play / pause (Space)">${icon("play")}</button>
      <div class="tc num" id="tc"><b>0:00.0</b> / 0:00.0</div>
      <button class="icon-btn" id="loopBtn" title="Loop playback">${icon("refresh")}</button>
      <button class="icon-btn" id="safeBtn" title="Show where TikTok / Reels buttons sit">${icon("frame")}</button>
    </div>
  </div>

  <aside class="studio-inspector">
    <div class="tabs" id="tabs">
      ${[
        ["clip", "Cut", "clip"],
        ["frame", "Frame", "frame"],
        ["text", "Text", "text"],
        ["look", "Look", "look"],
        ["audio", "Audio", "audio"],
      ]
        .map(([id, label, ic]) => `<button class="tab" data-tab="${id}">${icon(ic)}${label}</button>`)
        .join("")}
    </div>
    <div class="inspector-body" id="inspector"></div>
  </aside>

  <div class="timeline">
    <div class="tl-tools">
      <button class="icon-btn" data-act="split" title="Split at playhead (S)">${icon("split")}</button>
      <button class="icon-btn" data-act="setIn" title="Trim start to playhead (I)"><b style="font-size:13px">[</b></button>
      <button class="icon-btn" data-act="setOut" title="Trim end to playhead (O)"><b style="font-size:13px">]</b></button>
      <button class="icon-btn" data-act="delete" title="Delete selected (Del)">${icon("trash")}</button>
      <span class="bar-sep"></span>
      <button class="icon-btn" data-act="addText" title="Add text at playhead (T)">${icon("text")}</button>
      <span class="spacer"></span>
      <span class="muted num" style="font-size:12px" id="tlTotal"></span>
      <input type="range" class="zoom" id="tlZoom" min="0" max="100" value="40" title="Zoom timeline">
      <button class="btn ghost sm" id="tlFit">Fit</button>
    </div>
    <div class="tl-scroll" id="tlScroll">
      <div class="tl-inner" id="tlInner">
        <div class="tl-ruler" id="tlRuler"></div>
        <div class="tl-track"><div class="tl-track-label" title="Video">${icon("film")}</div><div class="tl-lane" id="laneVideo"></div></div>
        <div class="tl-track"><div class="tl-track-label" title="Text">${icon("text")}</div><div class="tl-lane" id="laneText"></div></div>
        <div class="tl-playhead" id="playhead"></div>
        <div class="tl-hint" id="tlHint">Drag media here, or import a video to get started.</div>
      </div>
    </div>
  </div>
</div>`;

// ============================================================ history ===
const snapshot = () => JSON.stringify(engine.project);

function commit(key) {
  const now = Date.now();
  dirty = true;
  if (key && key === lastCommit.key && now - lastCommit.at < 900) {
    lastCommit.at = now;
    return;
  }
  history.push(snapshot());
  if (history.length > 200) history.shift();
  future = [];
  lastCommit = { key, at: now };
  updateUndo();
}

function undo() {
  if (!history.length) return;
  future.push(snapshot());
  engine.project = JSON.parse(history.pop());
  lastCommit = { key: null, at: 0 };
  afterProjectChange();
}

function redo() {
  if (!future.length) return;
  history.push(snapshot());
  engine.project = JSON.parse(future.pop());
  lastCommit = { key: null, at: 0 };
  afterProjectChange();
}

function updateUndo() {
  $("#undoBtn", root).disabled = !history.length;
  $("#redoBtn", root).disabled = !future.length;
}

function afterProjectChange() {
  const p = engine.project;
  if (selSeg && !p.segments.find((s) => s.id === selSeg)) selSeg = null;
  if (engine.selectedText && !p.texts.find((t) => t.id === engine.selectedText)) engine.selectedText = null;
  $("#projName", root).value = p.name;
  engine.resize();
  engine.applyAudio();
  updateUndo();
  renderAll();
  engine.seek(Math.min(engine.t, engine.duration));
}

// ============================================================= helpers ===
const P = () => engine.project;
const seg = (id = selSeg) => P().segments.find((s) => s.id === id);
const text = (id = engine.selectedText) => P().texts.find((t) => t.id === id);
const src = (id) => engine.sources.get(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderTimeline();
    renderBin();
  });
}

function renderAll() {
  renderBin();
  renderTabs();
  renderInspector();
  renderTimeline();
  updateTransport();
  fitCanvas();
  const empty = !P().segments.length;
  $("#stageEmpty", root).classList.toggle("hidden", !empty);
  $("#stageCanvas", root).classList.toggle("hidden", empty);
}

// ============================================================= sources ===
async function importFiles(files) {
  const list = [...files].filter(isVideoFile);
  if (!list.length) return toast("No videos found", { sub: "Use MP4, MOV or WebM", type: "err" });
  const wasEmpty = !P().segments.length;
  let added = 0;
  for (const file of list) {
    const close = toast(`Importing ${file.name}`, { sub: bytes(file.size), timeout: 0 });
    try {
      const s = await engine.addSource(file);
      if (wasEmpty) appendSource(s, { silent: true });
      added++;
    } catch (err) {
      toastError(err, "Import failed");
    } finally {
      close();
    }
  }
  if (added) {
    if (wasEmpty && P().name === "Untitled clip") {
      P().name = list[0].name.replace(/\.[^.]+$/, "").slice(0, 60);
      $("#projName", root).value = P().name;
    }
    toast(added === 1 ? "Video imported" : `${added} videos imported`, {
      sub: wasEmpty ? "It's on the timeline. Press Space to play." : "Drag it from Media onto the timeline.",
      type: "ok",
    });
    ppsAuto = true;
    renderAll();
    engine.seek(engine.t);
  }
}

async function openClip(clip) {
  try {
    const s = await engine.addSource(clip.url, clip.name);
    if (!P().segments.length) appendSource(s, { silent: true });
    renderAll();
    engine.seek(engine.t);
    toast("Opened in Studio", { sub: clip.name, type: "ok" });
  } catch (err) {
    toastError(err, "Couldn't open clip");
  }
}

function appendSource(s, { at, silent } = {}) {
  if (!silent) commit();
  const item = { id: newId(), src: s.id, in: 0, out: s.duration };
  const list = P().segments;
  if (at == null || at >= list.length) list.push(item);
  else list.splice(at, 0, item);
  selSeg = item.id;
  dirty = true;
  ppsAuto = true;
  if (!silent) {
    renderAll();
    engine.seek(engine.t);
  }
}

// ============================================================ editing ===
function split() {
  const loc = engine.locate(engine.t);
  if (!loc) return;
  const s = seg(loc.seg.id);
  if (loc.srcTime - s.in < 0.05 || s.out - loc.srcTime < 0.05) return toast("Move the playhead inside a cut to split it");
  commit();
  const a = { ...s, id: newId(), out: loc.srcTime };
  const b = { ...s, id: newId(), in: loc.srcTime };
  P().segments.splice(loc.index, 1, a, b);
  selSeg = b.id;
  renderAll();
}

function setIn() {
  const loc = engine.locate(engine.t);
  if (!loc) return;
  const s = seg(loc.seg.id);
  if (s.out - loc.srcTime < 0.1) return;
  commit();
  s.in = loc.srcTime;
  selSeg = s.id;
  renderAll();
  engine.seek(loc.seg.start);
}

function setOut() {
  const loc = engine.locate(engine.t);
  if (!loc) return;
  const s = seg(loc.seg.id);
  if (loc.srcTime - s.in < 0.1) return;
  commit();
  s.out = loc.srcTime;
  selSeg = s.id;
  renderAll();
  engine.seek(engine.t);
}

function deleteSelected() {
  if (engine.selectedText && tab === "text") return deleteText();
  const s = seg();
  if (!s) {
    if (engine.selectedText) return deleteText();
    return toast("Select a cut on the timeline first");
  }
  commit();
  const i = P().segments.indexOf(s);
  P().segments.splice(i, 1);
  selSeg = P().segments[Math.min(i, P().segments.length - 1)]?.id || null;
  renderAll();
  engine.seek(Math.min(engine.t, engine.duration));
}

function moveSeg(dir) {
  const list = P().segments;
  const i = list.findIndex((s) => s.id === selSeg);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  commit();
  [list[i], list[j]] = [list[j], list[i]];
  renderAll();
  engine.seek(engine.layout()[j].start);
}

function duplicateSeg() {
  const s = seg();
  if (!s) return;
  commit();
  const i = P().segments.indexOf(s);
  const copy = { ...s, id: newId() };
  P().segments.splice(i + 1, 0, copy);
  selSeg = copy.id;
  renderAll();
}

// Keep only the first `limit` seconds of the timeline.
function trimTo(limit) {
  if (engine.duration <= limit) return toast(`Already under ${limit}s`);
  commit();
  const speed = P().speed || 1;
  let acc = 0;
  const out = [];
  for (const s of P().segments) {
    const d = (s.out - s.in) / speed;
    if (acc + d <= limit) {
      out.push(s);
      acc += d;
      continue;
    }
    const keep = limit - acc;
    if (keep > 0.1) out.push({ ...s, out: s.in + keep * speed });
    break;
  }
  P().segments = out;
  for (const t of P().texts) {
    t.start = Math.min(t.start, limit - 0.2);
    t.end = Math.min(t.end, limit);
  }
  P().texts = P().texts.filter((t) => t.end - t.start > 0.1);
  renderAll();
  engine.seek(Math.min(engine.t, engine.duration));
  toast(`Trimmed to ${limit}s`, { type: "ok" });
}

function addText(preset = {}) {
  commit();
  const t0 = engine.t;
  const total = engine.duration || 3;
  const layer = {
    id: newId(),
    text: "Your text here",
    start: t0 >= total - 0.2 ? 0 : t0,
    end: 0,
    x: 0.5,
    y: 0.5,
    size: 7,
    style: "outline",
    color: "#ffffff",
    upper: true,
    anim: "pop",
    ...preset,
  };
  if (!layer.end) layer.end = Math.min(layer.start + 3, Math.max(total, layer.start + 1));
  P().texts.push(layer);
  engine.selectedText = layer.id;
  tab = "text";
  renderAll();
  engine.draw();
  requestAnimationFrame(() => {
    const ta = $("#txtContent", root);
    ta?.focus();
    ta?.select();
  });
}

function deleteText() {
  const t = text();
  if (!t) return;
  commit();
  P().texts = P().texts.filter((x) => x.id !== t.id);
  engine.selectedText = null;
  renderAll();
  engine.draw();
}

// Turn a transcript into evenly timed caption chunks.
function generateCaptions(script, perChunk, replace) {
  const words = script.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const total = engine.duration;
  if (!words.length || !total) return;
  commit();
  if (replace) P().texts = P().texts.filter((t) => !t.auto);
  const chunks = [];
  for (let i = 0; i < words.length; i += perChunk) chunks.push(words.slice(i, i + perChunk).join(" "));
  // weight each chunk by its character count so long words get more time
  const weights = chunks.map((c) => c.length + 4);
  const sum = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  const base = text() || {};
  chunks.forEach((c, i) => {
    const d = (weights[i] / sum) * total;
    P().texts.push({
      id: newId(),
      text: c,
      start: t,
      end: Math.min(total, t + d),
      x: 0.5,
      y: base.y ?? 0.68,
      size: base.size ?? 7.5,
      style: base.style ?? "outline",
      color: base.color ?? "#ffffff",
      upper: base.upper ?? true,
      anim: "pop",
      auto: true,
    });
    t += d;
  });
  engine.selectedText = null;
  renderAll();
  engine.draw();
  toast(`${chunks.length} captions added`, { sub: "Drag their edges on the text track to fine-tune timing", type: "ok" });
}

// ============================================================= render ===
function renderBin() {
  const list = $("#binList", root);
  const sources = [...engine.sources.values()];
  $("#binCount", root).textContent = sources.length ? sources.length : "";
  if (!sources.length) {
    list.innerHTML = `<p class="muted" style="font-size:12px">Nothing imported yet.</p>`;
    return;
  }
  list.innerHTML = sources
    .map(
      (s) => `<div class="bin-item" draggable="true" data-src="${s.id}" title="Drag onto the timeline">
        ${s.thumbs[0] ? `<img src="${s.thumbs[0]}" alt="">` : `<div class="bin-ph"></div>`}
        <div style="min-width:0"><div class="name">${esc(s.name)}</div><div class="sub num">${duration(s.duration)} · ${s.width}×${s.height}</div></div>
        <div class="row" style="gap:0">
          <button class="icon-btn" data-add="${s.id}" title="Add to end of timeline">${icon("plus")}</button>
          <button class="icon-btn" data-remove="${s.id}" title="Remove from media">${icon("x")}</button>
        </div>
      </div>`
    )
    .join("");
}

function renderTabs() {
  $$(".tab", root).forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
}

function slider(id, label, value, min, max, step, fmt) {
  return `<div class="slider"><div class="slider-head"><span>${label}</span><output id="${id}Out">${fmt(value)}</output></div>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;
}

function sw(id, label, checked) {
  return `<label class="row" style="justify-content:space-between;margin-bottom:12px;cursor:pointer"><span style="font-size:13px;color:var(--text-2)">${label}</span>
    <span class="switch"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}><i></i></span></label>`;
}

function segBtns(name, options, current) {
  return `<div class="seg" data-seg="${name}">${options
    .map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(current) ? "on" : ""}">${l}</button>`)
    .join("")}</div>`;
}

function renderInspector() {
  const el = $("#inspector", root);
  const p = P();
  const has = p.segments.length > 0;
  let h = "";

  if (tab === "clip") {
    const s = seg();
    const lay = engine.layout();
    if (!has) {
      h = `<div class="empty" style="padding:30px 16px"><h3>No cuts yet</h3><p>Import a video. It lands here as one long cut you can split and trim.</p></div>`;
    } else {
      h += `<div class="group"><h4>Selected cut</h4>`;
      if (s) {
        const so = src(s.src);
        h += `<p style="font-size:13px;margin-bottom:12px" class="row"><b style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(so?.name || "Missing media")}</b></p>
          <div class="two">
            <label class="field"><span>Start (s)</span><input class="input num" type="number" id="segIn" step="0.1" min="0" value="${s.in.toFixed(2)}"></label>
            <label class="field"><span>End (s)</span><input class="input num" type="number" id="segOut" step="0.1" min="0" value="${s.out.toFixed(2)}"></label>
          </div>
          <p class="help" style="margin:-6px 0 14px">Length ${timecode((s.out - s.in) / (p.speed || 1))} on the timeline</p>
          <div class="row wrap" style="gap:6px">
            <button class="btn sm" data-act="split">${icon("split")}Split</button>
            <button class="btn sm" data-act="setIn">[ Trim start</button>
            <button class="btn sm" data-act="setOut">Trim end ]</button>
            <button class="btn sm" data-act="dup">${icon("copy")}Duplicate</button>
            <button class="btn sm" data-act="left">← Move</button>
            <button class="btn sm" data-act="right">Move →</button>
            <button class="btn sm danger" data-act="delete">${icon("trash")}Delete</button>
          </div>`;
      } else {
        h += `<p class="help">Click a cut on the timeline to edit it.</p>`;
      }
      h += `</div><div class="group"><h4>Cuts · ${p.segments.length}</h4><div class="text-list">${lay
        .map(
          (l, i) => `<div class="text-item ${l.id === selSeg ? "on" : ""}" data-pick-seg="${l.id}"><b style="color:var(--gold);font-weight:600">${
            i + 1
          }</b><span>${esc(src(l.src)?.name || "Missing")}</span><small>${timecode(l.dur)}</small></div>`
        )
        .join("")}</div></div>
      <div class="group"><h4>Fit to a length</h4><div class="row wrap" style="gap:6px">
        ${[15, 30, 60, 90].map((n) => `<button class="btn sm" data-trim="${n}">${n}s</button>`).join("")}
      </div><p class="help" style="margin-top:10px">Keeps the start and cuts the rest. Shorter clips get watched to the end more often.</p></div>`;
    }
  }

  if (tab === "frame") {
    h += `<div class="group"><h4>Format</h4>${segBtns(
      "aspect",
      Object.keys(ASPECTS).map((a) => [a, a]),
      p.aspect
    )}<p class="help" style="margin-top:-6px">9:16 for TikTok, Reels and Shorts.</p></div>
    <div class="group"><h4>Fill</h4>${segBtns(
      "fit",
      [
        ["blur", "Blur bg"],
        ["fill", "Crop"],
        ["fit", "Bars"],
      ],
      p.fit
    )}
    ${slider("zoom", "Zoom", Math.round(p.zoom * 100), 50, 300, 1, (v) => `${v}%`)}
    ${slider("panX", "Left / right", Math.round(p.panX * 100), -60, 60, 1, (v) => `${v > 0 ? "+" : ""}${v}`)}
    ${slider("panY", "Up / down", Math.round(p.panY * 100), -60, 60, 1, (v) => `${v > 0 ? "+" : ""}${v}`)}
    <button class="btn sm ghost" data-act="resetFrame">Reset framing</button></div>
    <div class="callout">${icon("bolt")}<span>Drag the video in the preview to reposition it. Drag a caption to move it.</span></div>`;
  }

  if (tab === "text") {
    const t = text();
    h += `<div class="group"><div class="row" style="gap:6px;margin-bottom:12px">
        <button class="btn sm primary" data-act="addText">${icon("plus")}Text</button>
        <button class="btn sm" data-act="addHook">${icon("bolt")}Hook title</button>
        <button class="btn sm" data-act="addCaption">${icon("comment")}Caption</button>
      </div>
      <div class="text-list">${
        p.texts.length
          ? p.texts
              .slice()
              .sort((a, b) => a.start - b.start)
              .map(
                (x) => `<div class="text-item ${x.id === engine.selectedText ? "on" : ""}" data-pick-text="${x.id}"><span>${esc(
                  x.text || "(empty)"
                )}</span><small>${timecode(x.start)}</small></div>`
              )
              .join("")
          : `<p class="help">No text yet. A hook in the first 2 seconds stops the scroll.</p>`
      }</div></div>`;
    if (t) {
      h += `<div class="group"><h4>Edit text</h4>
        <label class="field"><textarea class="input" id="txtContent" rows="3" style="min-height:76px">${esc(t.text)}</textarea></label>
        <div class="preset-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">${Object.entries(TEXT_STYLES)
          .map(
            ([k, v]) =>
              `<button class="preset ${t.style === k ? "on" : ""}" data-style="${k}"><span class="sample" style="${styleSample(k)}">${v.sample}</span>${v.label}</button>`
          )
          .join("")}</div>
        <div class="label" style="margin-bottom:8px">Colour</div>
        <div class="color-row" style="margin-bottom:16px">${COLORS.map(
          (c) => `<button class="swatch ${t.color.toLowerCase() === c ? "on" : ""}" data-color="${c}" style="background:${c}" title="${c}"></button>`
        ).join("")}<input type="color" id="txtColor" value="${t.color}" title="Custom colour" style="width:30px;height:30px;padding:2px;border-radius:50%"></div>
        ${slider("txtSize", "Size", t.size, 3, 16, 0.1, (v) => Number(v).toFixed(1))}
        ${sw("txtUpper", "ALL CAPS", t.upper)}
        <div class="label" style="margin-bottom:8px">Entrance</div>
        ${segBtns(
          "anim",
          [
            ["none", "None"],
            ["pop", "Pop"],
            ["rise", "Rise"],
            ["fade", "Fade"],
          ],
          t.anim
        )}
        <div class="two">
          <label class="field"><span>Shows at (s)</span><input class="input num" type="number" id="txtStart" step="0.1" min="0" value="${t.start.toFixed(2)}"></label>
          <label class="field"><span>Hides at (s)</span><input class="input num" type="number" id="txtEnd" step="0.1" min="0" value="${t.end.toFixed(2)}"></label>
        </div>
        <div class="row wrap" style="gap:6px">
          <button class="btn sm" data-act="txtHere">Start at playhead</button>
          <button class="btn sm" data-act="txtEndHere">End at playhead</button>
          <button class="btn sm" data-act="txtFull">Whole clip</button>
          <button class="btn sm" data-act="txtCenter">Center</button>
          <button class="btn sm" data-act="txtDup">${icon("copy")}Copy</button>
          <button class="btn sm danger" data-act="txtDelete">${icon("trash")}Delete</button>
        </div></div>`;
    }
    h += `<details class="group" ${p.texts.some((x) => x.auto) ? "" : ""}><summary class="label" style="cursor:pointer;list-style:none;margin-bottom:10px">+ Captions from a transcript</summary>
      <p class="help" style="margin-bottom:10px">Paste what's said in the clip. It gets split into short captions spread across the timeline, using the selected text's style. Then nudge timings on the text track.</p>
      <textarea class="input" id="scriptIn" rows="5" placeholder="Paste the transcript here…"></textarea>
      <div class="row" style="margin:10px 0">
        <span class="help">Words per caption</span>
        <select class="input" id="scriptWords" style="width:80px;height:34px">${[1, 2, 3, 4, 5, 6].map((n) => `<option ${n === 3 ? "selected" : ""}>${n}</option>`).join("")}</select>
      </div>
      <label class="check"><input type="checkbox" id="scriptReplace" checked>Replace earlier transcript captions</label>
      <button class="btn sm primary" style="margin-top:10px" data-act="genCaptions">Generate captions</button>
    </details>`;
  }

  if (tab === "look") {
    const l = p.look;
    h += `<div class="group"><h4>Grade</h4><div class="preset-grid" style="grid-template-columns:repeat(3,1fr)">${Object.entries(LOOKS)
      .map(
        ([k, v]) =>
          `<button class="preset ${l.preset === k ? "on" : ""}" data-look="${k}"><span class="sample" style="display:block;width:22px;height:22px;border-radius:50%;margin:0 auto 6px;background:${v.chip}"></span>${v.label}</button>`
      )
      .join("")}</div></div>
    <div class="group"><h4>Adjust</h4>
      ${slider("lkBright", "Brightness", l.brightness, 50, 150, 1, (v) => `${v}%`)}
      ${slider("lkContrast", "Contrast", l.contrast, 50, 160, 1, (v) => `${v}%`)}
      ${slider("lkSat", "Saturation", l.saturate, 0, 200, 1, (v) => `${v}%`)}
      ${slider("lkVig", "Vignette", l.vignette, 0, 100, 1, (v) => `${v}`)}
      ${engine.supportsFilter ? "" : `<p class="help">This browser can't apply colour filters. Use Chrome, Edge or Firefox for grading.</p>`}
    </div>
    <div class="group"><h4>Finish</h4>
      ${sw("fxFadeIn", "Fade in from black", p.fadeIn)}
      ${sw("fxFadeOut", "Fade out to black", p.fadeOut)}
      ${sw("fxProgress", "Progress bar", p.progressBar)}
      <label class="field"><span>Watermark</span><input class="input" id="fxWatermark" placeholder="@yourhandle" value="${esc(p.watermark)}"></label>
    </div>`;
  }

  if (tab === "audio") {
    h += `<div class="group"><h4>Volume</h4>
      ${slider("auVol", "Level", Math.round(p.volume * 100), 0, 200, 1, (v) => `${v}%`)}
      ${sw("auMute", "Mute original audio", p.muted)}</div>
      <div class="group"><h4>Speed</h4>${segBtns(
        "speed",
        SPEEDS.map((s) => [s, `${s}×`]),
        p.speed
      )}<p class="help">Speeding up to 1.25× tightens a clip without sounding off. Pitch is kept.</p></div>`;
  }

  el.innerHTML = h;
  paintRanges(el);
}

function styleSample(k) {
  if (k === "outline") return "font-weight:800;color:#fff;-webkit-text-stroke:1px #000;text-shadow:0 0 1px #000";
  if (k === "box") return "font-weight:700;background:#fff;color:#000;padding:0 6px;border-radius:4px;display:inline-block";
  if (k === "gold") return "font-family:var(--font-display);color:var(--gold-hi)";
  if (k === "neon") return "font-weight:800;color:#25f4ee;text-shadow:0 0 8px #25f4ee";
  return "font-weight:700;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.6)";
}

// ------------------------------------------------------------ timeline ---
function tickStep() {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  return steps.find((s) => s * pps >= 70) || 3600;
}

function renderTimeline() {
  const scroll = $("#tlScroll", root);
  const inner = $("#tlInner", root);
  const total = engine.duration;
  const avail = Math.max(200, scroll.clientWidth - 64 - 30);
  if (ppsAuto) {
    pps = clamp(avail / Math.max(total, 5), 2, 600);
    $("#tlZoom", root).value = String(Math.round((Math.log(pps / 2) / Math.log(300)) * 100));
    paintRanges($(".tl-tools", root));
  }
  const width = Math.max(avail, total * pps + 120);
  inner.style.width = `${width + 64}px`;
  $("#tlTotal", root).textContent = total ? `${timecode(total)} total` : "";
  $("#tlHint", root).classList.toggle("hidden", P().segments.length > 0);

  // ruler
  const step = tickStep();
  const minor = step / 5;
  let ticks = "";
  for (let t = 0; t <= width / pps; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ticks += `<div class="tl-tick ${major ? "major" : ""}" style="left:${t * pps}px">${major ? `<span>${duration(t)}</span>` : ""}</div>`;
    if (ticks.length > 60000) break;
  }
  $("#tlRuler", root).innerHTML = ticks;

  // video cuts
  const lay = engine.layout();
  $("#laneVideo", root).innerHTML = lay
    .map((l) => {
      const so = src(l.src);
      const w = l.dur * pps;
      let strip = "";
      if (so?.thumbs.length) {
        const tileW = 60 * ((so.width || 16) / (so.height || 9));
        const n = Math.min(160, Math.ceil(w / tileW));
        for (let i = 0; i < n; i++) {
          const at = l.in + ((i + 0.5) * tileW) / pps * (P().speed || 1);
          const idx = clamp(Math.floor(at / so.thumbEvery), 0, so.thumbs.length - 1);
          const img = so.thumbs[idx] || so.thumbs.find(Boolean);
          if (img) strip += `<img src="${img}" style="width:${tileW}px" alt="">`;
        }
      }
      return `<div class="tl-seg ${l.id === selSeg ? "on" : ""}" data-seg-id="${l.id}" style="left:${l.start * pps}px;width:${Math.max(4, w)}px">
        <div class="strip">${strip}</div>
        <div class="handle l" data-h="l"></div><div class="handle r" data-h="r"></div>
        ${w > 70 ? `<div class="seg-label">${esc(so?.name || "Missing")} · ${timecode(l.dur)}</div>` : ""}
      </div>`;
    })
    .join("");

  // text lanes (greedy packing so overlaps stack)
  const lanes = [];
  const placed = P()
    .texts.slice()
    .sort((a, b) => a.start - b.start)
    .map((t) => {
      let lane = lanes.findIndex((end) => end <= t.start + 1e-3);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(0);
      }
      lanes[lane] = t.end;
      return { t, lane };
    });
  const laneText = $("#laneText", root);
  laneText.style.height = `${Math.max(1, lanes.length) * 28 + 4}px`;
  laneText.innerHTML = placed
    .map(
      ({ t, lane }) => `<div class="tl-text ${t.id === engine.selectedText ? "on" : ""}" data-text-id="${t.id}" style="left:${t.start * pps}px;width:${Math.max(
        10,
        (t.end - t.start) * pps
      )}px;top:${lane * 28}px" title="${esc(t.text)}">
        <div class="handle l" data-h="l"></div>${esc(t.text)}<div class="handle r" data-h="r"></div></div>`
    )
    .join("");
  updatePlayhead();
}

function updatePlayhead() {
  const x = 64 + engine.t * pps;
  $("#playhead", root).style.transform = `translateX(${x}px)`;
  if (engine.playing) {
    const sc = $("#tlScroll", root);
    if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft + 64) sc.scrollLeft = x - 120;
  }
}

function updateTransport() {
  const btn = $("#playBtn", root);
  btn.innerHTML = icon(engine.playing ? "pause" : "play");
  $("#tc", root).innerHTML = `<b>${timecode(engine.t)}</b> / ${timecode(engine.duration)}`;
  $("#loopBtn", root).classList.toggle("on", engine.loop);
  $("#safeBtn", root).classList.toggle("on", engine.showSafe);
}

function fitCanvas() {
  const wrap = $("#stageWrap", root);
  const canvas = $("#stageCanvas", root);
  const W = wrap.clientWidth - 36;
  const H = wrap.clientHeight - 36;
  if (W <= 0 || H <= 0) return;
  const ar = canvas.width / canvas.height;
  let w = W;
  let h = W / ar;
  if (h > H) {
    h = H;
    w = H * ar;
  }
  canvas.style.width = `${Math.floor(w)}px`;
  canvas.style.height = `${Math.floor(h)}px`;
}

// ============================================================== export ===
function slug(s) {
  return (s || "clip").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "clip";
}

function openExport() {
  if (!P().segments.length) return toast("Nothing to export yet", { sub: "Import a video first", type: "err" });
  engine.pause();
  const pr = prefs();
  const mime = pickMime();
  const isWebm = mime?.includes("webm");
  const ff = server.health?.ffmpeg;
  const total = engine.duration;
  const m = modal({
    title: "Export clip",
    body: `<p class="muted" style="margin-bottom:22px">Renders in real time, so a ${duration(total)} clip takes about ${duration(total)}. Keep this tab open and visible.</p>
      <label class="field"><span>Name</span><input class="input" id="exName" value="${esc(P().name)}"></label>
      <div class="label" style="margin-bottom:8px">Quality</div>
      ${segBtns("exQ", [["1080", "1080p"], ["720", "720p"]], pr.quality)}
      <div class="label" style="margin-bottom:8px">Frame rate</div>
      ${segBtns("exF", [[30, "30 fps"], [60, "60 fps"]], pr.fps)}
      <p class="help">Format: <b>${isWebm ? "WebM" : "MP4"}</b>${
        isWebm && !ff
          ? ` · Instagram wants MP4. Install ffmpeg and restart the server so clips get converted automatically, or export in Chrome / Edge.`
          : ff
          ? " · converted to clean MP4 by the server"
          : ""
      }${server.online ? "" : " · Server offline: the clip stays in this tab only, download it after export."}</p>`,
    actions: [
      { label: "Cancel", kind: "ghost", onClick: (m) => m.close() },
      { label: "Export", kind: "primary", icon: "download", onClick: (m) => runExport(m) },
    ],
  });
  $$(".seg", m.body).forEach((g) =>
    g.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $$("button", g).forEach((x) => x.classList.toggle("on", x === b));
    })
  );
}

async function runExport(m) {
  const name = $("#exName", m.body).value.trim() || P().name;
  const quality = $('[data-seg="exQ"] .on', m.body)?.dataset.v || "1080";
  const fps = Number($('[data-seg="exF"] .on', m.body)?.dataset.v || 30);
  setPrefs({ quality, fps });
  P().name = name;
  $("#projName", root).value = name;
  engine.setQuality(quality);
  fitCanvas();

  const total = engine.duration;
  m.body.innerHTML = `<p class="muted" style="margin-bottom:16px" id="exStage">Rendering…</p>
    <div class="progress"><i id="exBar"></i></div>
    <p class="help num" style="margin-top:10px" id="exTime">0:00.0 / ${timecode(total)}</p>`;
  m.setActions([{ label: "Cancel", kind: "ghost", onClick: () => engine.cancelExport() }]);

  const onHide = () => document.hidden && toast("Keep this tab visible", { sub: "Browsers slow down hidden tabs, which makes exports stutter.", type: "err" });
  document.addEventListener("visibilitychange", onHide);
  let thumbBlob = null;
  try {
    const blob = await engine.exportVideo({
      fps,
      bitrate: quality === "720" ? 6 : fps === 60 ? 14 : 10,
      onProgress: (p, t) => {
        $("#exBar", m.body).style.width = `${p * 100}%`;
        $("#exTime", m.body).textContent = `${timecode(t)} / ${timecode(total)}`;
      },
      onThumb: (b) => (thumbBlob = b),
    });
    await new Promise((r) => setTimeout(r, 150));
    $("#exStage", m.body).textContent = server.online ? "Saving to your library…" : "Finishing…";
    $("#exBar", m.body).style.width = "0%";
    const [width, height] = engine.dims();
    const clip = await saveClip(
      blob,
      { name, duration: total.toFixed(2), width, height, thumbBlob, source: "studio" },
      (p) => ($("#exBar", m.body).style.width = `${p * 100}%`)
    );
    dirty = false;
    const ext = blob.type.includes("webm") ? "webm" : "mp4";
    m.body.innerHTML = `<p class="muted" style="margin-bottom:16px">${esc(clip.name)} · ${duration(total)} · ${bytes(blob.size)}${
      clip.status === "processing" ? " · converting to MP4 in the background" : ""
    }</p>
      <video src="${clip.url}" controls playsinline style="width:100%;max-height:50vh;background:#000"></video>`;
    m.setActions([
      { label: "Download", icon: "download", onClick: () => download(clip.local ? clip.url : clip.url, `${slug(name)}.${ext}`) },
      { label: "Library", kind: "ghost", onClick: (m) => (m.close(), app.navigate("library")) },
      ...(server.online ? [{ label: "Post it", kind: "primary", icon: "publish", onClick: (m) => (m.close(), app.navigate(`publish?clip=${clip.id}`)) }] : []),
    ]);
  } catch (err) {
    if (err.cancelled) {
      m.close();
      toast("Export cancelled");
    } else {
      m.body.innerHTML = `<div class="callout warn">${icon("x")}<span>${esc(err.message)}</span></div>`;
      m.setActions([{ label: "Close", onClick: (m) => m.close() }]);
    }
  } finally {
    document.removeEventListener("visibilitychange", onHide);
    engine.seek(0);
  }
}

function shortcuts() {
  const rows = [
    ["Space", "Play / pause"],
    ["S", "Split at playhead"],
    ["I / O", "Trim cut start / end to playhead"],
    ["Del", "Delete selected cut or text"],
    ["T", "Add text"],
    ["← / →", "Step one frame (Shift: 1 second)"],
    ["Home / End", "Jump to start / end"],
    ["Ctrl Z / Ctrl Shift Z", "Undo / redo"],
    ["Ctrl E", "Export"],
  ];
  modal({
    title: "Shortcuts",
    body: `<div class="tips" style="margin-top:14px">${rows
      .map(([k, v]) => `<div style="justify-content:space-between"><span>${v}</span><span class="kbd" style="font-size:11px;padding:1px 8px">${k}</span></div>`)
      .join("")}</div>`,
    actions: [{ label: "Got it", kind: "primary", onClick: (m) => m.close() }],
  });
}

async function newProject() {
  if (dirty && P().segments.length) {
    const ok = await import("../ui.js").then((u) => u.confirmDialog("Start a new clip?", "The current edit will be cleared. Imported media stays in the Media panel.", { ok: "Start new" }));
    if (!ok) return;
  }
  engine.pause();
  commit();
  const keepQuality = engine.quality;
  engine.project = { ...defaultProject(), watermark: prefs().watermark || "" };
  engine.quality = keepQuality;
  engine.t = 0;
  selSeg = null;
  engine.selectedText = null;
  dirty = false;
  afterProjectChange();
}

// ============================================================== events ===
function bind() {
  const q = (s) => $(s, root);

  // file inputs + bin drop zone highlighting
  $$('input[type="file"]', root).forEach((inp) =>
    inp.addEventListener("change", () => {
      importFiles(inp.files);
      inp.value = "";
    })
  );
  $$(".dropzone", root).forEach((dz) => {
    dz.addEventListener("dragover", () => dz.classList.add("over"));
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", () => dz.classList.remove("over"));
  });

  q("#projName").addEventListener("change", (e) => {
    commit();
    P().name = e.target.value.trim() || "Untitled clip";
  });
  q("#undoBtn").addEventListener("click", undo);
  q("#redoBtn").addEventListener("click", redo);
  q("#exportBtn").addEventListener("click", openExport);
  q("#keysBtn").addEventListener("click", shortcuts);
  q("#newBtn").addEventListener("click", newProject);

  q("#playBtn").addEventListener("click", () => engine.toggle()?.catch?.((e) => toastError(e, "Can't play")));
  q("#toStart").addEventListener("click", () => engine.seek(0));
  q("#loopBtn").addEventListener("click", () => {
    engine.loop = !engine.loop;
    updateTransport();
  });
  q("#safeBtn").addEventListener("click", () => {
    engine.showSafe = !engine.showSafe;
    updateTransport();
    engine.draw();
  });

  // tabs
  q("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    tab = b.dataset.tab;
    renderTabs();
    renderInspector();
    $("#inspector", root).scrollTop = 0;
  });

  // bin
  q("#binList").addEventListener("click", async (e) => {
    const add = e.target.closest("[data-add]");
    const rem = e.target.closest("[data-remove]");
    if (add) appendSource(src(add.dataset.add));
    if (rem) {
      const id = rem.dataset.remove;
      const used = P().segments.some((s) => s.src === id);
      if (used) {
        const { confirmDialog } = await import("../ui.js");
        if (!(await confirmDialog("Remove media?", "Cuts using this video will be removed from the timeline too.", { ok: "Remove", danger: true }))) return;
        commit();
        P().segments = P().segments.filter((s) => s.src !== id);
      }
      engine.removeSource(id);
      afterProjectChange();
    }
  });
  q("#binList").addEventListener("dragstart", (e) => {
    const item = e.target.closest("[data-src]");
    if (!item) return;
    e.dataTransfer.setData("application/x-clip-src", item.dataset.src);
    e.dataTransfer.effectAllowed = "copy";
  });
  const lane = q("#laneVideo");
  lane.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("application/x-clip-src")) {
      e.preventDefault();
      lane.classList.add("drop-target");
    }
  });
  lane.addEventListener("dragleave", () => lane.classList.remove("drop-target"));
  lane.addEventListener("drop", (e) => {
    const id = e.dataTransfer.getData("application/x-clip-src");
    lane.classList.remove("drop-target");
    if (!id) return;
    e.preventDefault();
    const x = e.clientX - lane.getBoundingClientRect().left;
    const t = x / pps;
    const at = engine.layout().findIndex((l) => t < l.start + l.dur / 2);
    appendSource(src(id), { at: at === -1 ? undefined : at });
  });

  // toolbar + inspector buttons (shared data-act)
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) return act(b.dataset.act);
    const pickSeg = e.target.closest("[data-pick-seg]");
    if (pickSeg) {
      selSeg = pickSeg.dataset.pickSeg;
      const l = engine.layout().find((x) => x.id === selSeg);
      renderInspector();
      renderTimeline();
      if (l) engine.seek(l.start);
      return;
    }
    const pickText = e.target.closest("[data-pick-text]");
    if (pickText) {
      engine.selectedText = pickText.dataset.pickText;
      const t = text();
      renderInspector();
      renderTimeline();
      if (t && (engine.t < t.start || engine.t >= t.end)) engine.seek(t.start + 0.01);
      else engine.draw();
      return;
    }
    const trim = e.target.closest("[data-trim]");
    if (trim) return trimTo(Number(trim.dataset.trim));
  });

  bindInspector();
  bindTimeline();
  bindCanvas();

  q("#tlZoom").addEventListener("input", (e) => {
    ppsAuto = false;
    pps = 2 * Math.pow(300, Number(e.target.value) / 100);
    renderTimeline();
  });
  q("#tlFit").addEventListener("click", () => {
    ppsAuto = true;
    renderTimeline();
  });

  // engine events
  engine.addEventListener("time", () => {
    updatePlayhead();
    $("#tc", root).innerHTML = `<b>${timecode(engine.t)}</b> / ${timecode(engine.duration)}`;
  });
  engine.addEventListener("state", updateTransport);
  engine.addEventListener("thumbs", scheduleRender);
  engine.addEventListener("sources", scheduleRender);

  new ResizeObserver(() => {
    fitCanvas();
    if (ppsAuto) renderTimeline();
  }).observe(q("#stageWrap"));

  document.addEventListener("keydown", onKey);
}

function act(name) {
  const t = text();
  const actions = {
    split,
    setIn,
    setOut,
    delete: deleteSelected,
    dup: duplicateSeg,
    left: () => moveSeg(-1),
    right: () => moveSeg(1),
    addText: () => addText(),
    addHook: () => addText({ text: "Wait for the end…", y: 0.2, size: 8, style: "gold", upper: false, anim: "rise", start: 0, end: Math.min(3, engine.duration || 3) }),
    addCaption: () => addText({ text: "Caption", y: 0.68, size: 7, style: "box", color: "#ffffff", upper: false, anim: "pop" }),
    resetFrame: () => {
      commit();
      Object.assign(P(), { zoom: 1, panX: 0, panY: 0 });
      renderInspector();
      engine.draw();
    },
    txtHere: () => t && (commit(), (t.start = Math.min(engine.t, t.end - 0.1)), renderInspector(), renderTimeline(), engine.draw()),
    txtEndHere: () => t && (commit(), (t.end = Math.max(engine.t, t.start + 0.1)), renderInspector(), renderTimeline(), engine.draw()),
    txtFull: () => t && (commit(), (t.start = 0), (t.end = engine.duration || t.end), renderInspector(), renderTimeline(), engine.draw()),
    txtCenter: () => t && (commit(), (t.x = 0.5), (t.y = 0.5), engine.draw()),
    txtDup: () => {
      if (!t) return;
      commit();
      const c = { ...t, id: newId(), y: Math.min(0.92, t.y + 0.08), auto: false };
      P().texts.push(c);
      engine.selectedText = c.id;
      renderInspector();
      renderTimeline();
      engine.draw();
    },
    txtDelete: deleteText,
    genCaptions: () => {
      const script = $("#scriptIn", root).value;
      if (!script.trim()) return toast("Paste a transcript first");
      if (!engine.duration) return toast("Add a video first");
      generateCaptions(script, Number($("#scriptWords", root).value), $("#scriptReplace", root).checked);
    },
  };
  actions[name]?.();
}

function bindInspector() {
  const el = $("#inspector", root);

  el.addEventListener("click", (e) => {
    const p = P();
    const segBtn = e.target.closest(".seg button");
    if (segBtn) {
      const group = segBtn.parentElement.dataset.seg;
      const v = segBtn.dataset.v;
      commit();
      if (group === "aspect") {
        p.aspect = v;
        engine.resize();
        fitCanvas();
      }
      if (group === "fit") p.fit = v;
      if (group === "speed") {
        const old = p.speed;
        p.speed = Number(v);
        // keep text in the same place relative to the footage
        for (const t of p.texts) {
          t.start = (t.start * old) / p.speed;
          t.end = (t.end * old) / p.speed;
        }
        engine.t = (engine.t * old) / p.speed;
        renderTimeline();
      }
      if (group === "anim" && text()) text().anim = v;
      renderInspector();
      engine.draw();
      updateTransport();
      return;
    }
    const look = e.target.closest("[data-look]");
    if (look) {
      commit();
      p.look = { preset: look.dataset.look, ...lookValues(LOOKS[look.dataset.look]) };
      renderInspector();
      engine.draw();
      return;
    }
    const style = e.target.closest("[data-style]");
    if (style && text()) {
      commit();
      const t = text();
      t.style = style.dataset.style;
      if (t.style === "gold" && t.color === "#0c0b0a") t.color = "#ffffff";
      renderInspector();
      engine.draw();
      return;
    }
    const color = e.target.closest("[data-color]");
    if (color && text()) {
      commit();
      text().color = color.dataset.color;
      renderInspector();
      engine.draw();
    }
  });

  el.addEventListener("input", (e) => {
    const id = e.target.id;
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    const p = P();
    const t = text();
    const n = Number(v);
    const out = $(`#${id}Out`, el);
    const map = {
      zoom: () => ((p.zoom = n / 100), out && (out.textContent = `${n}%`)),
      panX: () => ((p.panX = n / 100), out && (out.textContent = `${n > 0 ? "+" : ""}${n}`)),
      panY: () => ((p.panY = n / 100), out && (out.textContent = `${n > 0 ? "+" : ""}${n}`)),
      lkBright: () => ((p.look.brightness = n), (out.textContent = `${n}%`)),
      lkContrast: () => ((p.look.contrast = n), (out.textContent = `${n}%`)),
      lkSat: () => ((p.look.saturate = n), (out.textContent = `${n}%`)),
      lkVig: () => ((p.look.vignette = n), (out.textContent = `${n}`)),
      fxFadeIn: () => (p.fadeIn = v),
      fxFadeOut: () => (p.fadeOut = v),
      fxProgress: () => (p.progressBar = v),
      fxWatermark: () => (p.watermark = v),
      auVol: () => ((p.volume = n / 100), (out.textContent = `${n}%`), engine.applyAudio()),
      auMute: () => ((p.muted = v), engine.applyAudio()),
      txtContent: () => t && ((t.text = v), scheduleRender()),
      txtColor: () => t && (t.color = v),
      txtSize: () => t && ((t.size = n), (out.textContent = n.toFixed(1))),
      txtUpper: () => t && (t.upper = v),
    };
    if (!map[id]) return;
    commit(id);
    map[id]();
    engine.draw();
  });

  el.addEventListener("change", (e) => {
    const id = e.target.id;
    const n = Number(e.target.value);
    const s = seg();
    const t = text();
    if (id === "segIn" && s) {
      commit();
      s.in = clamp(n, 0, s.out - 0.1);
    } else if (id === "segOut" && s) {
      commit();
      s.out = clamp(n, s.in + 0.1, src(s.src)?.duration ?? n);
    } else if (id === "txtStart" && t) {
      commit();
      t.start = clamp(n, 0, t.end - 0.1);
    } else if (id === "txtEnd" && t) {
      commit();
      t.end = Math.max(t.start + 0.1, n);
    } else if (id === "txtContent" || id === "fxWatermark") {
      renderInspector();
      return renderTimeline();
    } else return;
    renderInspector();
    renderTimeline();
    engine.seek(engine.t);
  });
}

function bindTimeline() {
  const inner = $("#tlInner", root);
  const lane = $("#laneVideo", root);
  const timeAt = (clientX) => Math.max(0, (clientX - lane.getBoundingClientRect().left) / pps);

  inner.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const handle = e.target.closest(".handle");
    const segEl = e.target.closest(".tl-seg");
    const textEl = e.target.closest(".tl-text");
    const startX = e.clientX;
    let moved = false;
    let onMove;

    if (segEl) {
      const s = seg(segEl.dataset.segId);
      selSeg = s.id;
      const l0 = engine.layout().find((x) => x.id === s.id);
      const in0 = s.in;
      const out0 = s.out;
      const so = src(s.src);
      const speed = P().speed || 1;
      if (!handle) {
        engine.seek(timeAt(e.clientX));
        renderTimeline();
        renderInspector();
        onMove = (ev) => engine.seek(timeAt(ev.clientX));
      } else {
        onMove = (ev) => {
          const dt = ((ev.clientX - startX) / pps) * speed;
          if (!moved) commit();
          moved = true;
          if (handle.dataset.h === "l") {
            s.in = clamp(in0 + dt, 0, s.out - 0.1);
            engine.seek(l0.start);
          } else {
            s.out = clamp(out0 + dt, s.in + 0.1, so?.duration ?? out0);
            engine.seek(l0.start + (s.out - s.in) / speed - 0.02);
          }
          renderTimeline();
        };
      }
    } else if (textEl) {
      const t = text(textEl.dataset.textId);
      engine.selectedText = t.id;
      tab = "text";
      const s0 = t.start;
      const e0 = t.end;
      renderTabs();
      renderInspector();
      renderTimeline();
      if (engine.t < t.start || engine.t >= t.end) engine.seek(t.start + 0.01);
      else engine.draw();
      onMove = (ev) => {
        const dt = (ev.clientX - startX) / pps;
        if (Math.abs(ev.clientX - startX) < 3 && !moved) return;
        if (!moved) commit();
        moved = true;
        const h = handle?.dataset.h;
        if (h === "l") t.start = clamp(s0 + dt, 0, t.end - 0.2);
        else if (h === "r") t.end = Math.max(t.start + 0.2, e0 + dt);
        else {
          const len = e0 - s0;
          t.start = Math.max(0, s0 + dt);
          t.end = t.start + len;
        }
        engine.seek(h === "r" ? t.end - 0.02 : t.start + 0.01);
        renderTimeline();
      };
    } else {
      // ruler / empty lane: scrub
      engine.seek(timeAt(e.clientX));
      onMove = (ev) => engine.seek(timeAt(ev.clientX));
    }

    inner.setPointerCapture(e.pointerId);
    const up = () => {
      inner.removeEventListener("pointermove", onMove);
      inner.removeEventListener("pointerup", up);
      inner.removeEventListener("pointercancel", up);
      if (moved) {
        renderInspector();
        renderTimeline();
      }
    };
    inner.addEventListener("pointermove", onMove);
    inner.addEventListener("pointerup", up);
    inner.addEventListener("pointercancel", up);
  });
}

function bindCanvas() {
  const canvas = $("#stageCanvas", root);
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!P().segments.length) return;
    const pt = toCanvas(e);
    const hitId = engine.hitText(pt.x, pt.y);
    const W = canvas.width;
    const H = canvas.height;
    let moved = false;
    let onMove;
    if (hitId) {
      engine.selectedText = hitId;
      if (tab !== "text") {
        tab = "text";
        renderTabs();
      }
      renderInspector();
      renderTimeline();
      const t = text();
      const x0 = t.x;
      const y0 = t.y;
      onMove = (ev) => {
        const p2 = toCanvas(ev);
        if (!moved) commit();
        moved = true;
        let nx = clamp(x0 + (p2.x - pt.x) / W, 0.02, 0.98);
        if (Math.abs(nx - 0.5) < 0.015) nx = 0.5; // snap to centre
        t.x = nx;
        t.y = clamp(y0 + (p2.y - pt.y) / H, 0.03, 0.97);
        engine.draw();
      };
    } else {
      if (engine.selectedText) {
        engine.selectedText = null;
        renderInspector();
        renderTimeline();
        engine.draw();
      }
      const p = P();
      const px0 = p.panX;
      const py0 = p.panY;
      onMove = (ev) => {
        const p2 = toCanvas(ev);
        if (!moved) commit();
        moved = true;
        p.panX = clamp(px0 + (p2.x - pt.x) / W, -1, 1);
        p.panY = clamp(py0 + (p2.y - pt.y) / H, -1, 1);
        engine.draw();
      };
    }
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
    const up = () => {
      canvas.classList.remove("dragging");
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      if (moved && tab === "frame") renderInspector();
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  });

  canvas.addEventListener("dblclick", (e) => {
    const pt = toCanvas(e);
    if (engine.hitText(pt.x, pt.y)) $("#txtContent", root)?.focus();
  });
}

function onKey(e) {
  if (!visible || document.querySelector(".modal-back")) return;
  const tag = e.target.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod && key === "z" && !typing) {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && key === "y" && !typing) {
    e.preventDefault();
    return redo();
  }
  if (mod && key === "e") {
    e.preventDefault();
    return openExport();
  }
  if (typing || mod || e.altKey) return;

  const frame = 1 / 30;
  switch (e.key) {
    case " ":
      e.preventDefault();
      engine.toggle()?.catch?.((err) => toastError(err, "Can't play"));
      break;
    case "s":
    case "S":
      split();
      break;
    case "i":
    case "I":
      setIn();
      break;
    case "o":
    case "O":
      setOut();
      break;
    case "t":
    case "T":
      addText();
      break;
    case "Delete":
    case "Backspace":
      e.preventDefault();
      deleteSelected();
      break;
    case "ArrowLeft":
      e.preventDefault();
      engine.pause();
      engine.seek(engine.t - (e.shiftKey ? 1 : frame));
      break;
    case "ArrowRight":
      e.preventDefault();
      engine.pause();
      engine.seek(engine.t + (e.shiftKey ? 1 : frame));
      break;
    case "Home":
      engine.seek(0);
      break;
    case "End":
      engine.seek(engine.duration);
      break;
  }
}

// ================================================================ view ===
export default {
  mount(section, ctx) {
    app = ctx;
    root = section;
    section.classList.add("full");
    section.innerHTML = TEMPLATE();
    engine = new Engine($("#stageCanvas", root));
    engine.project.watermark = prefs().watermark || "";
    engine.setQuality(prefs().quality);
    bind();
    renderAll();
  },
  show(params = {}) {
    visible = true;
    requestAnimationFrame(() => {
      fitCanvas();
      renderTimeline();
    });
  },
  hide() {
    visible = false;
    engine?.pause();
  },
  importFiles,
  openClip,
  isDirty: () => dirty && P().segments.length > 0,
};
