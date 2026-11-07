// SETTINGS: export defaults, captions, server info.
import { prefs, setPrefs, server, checkHealth } from "../api.js";
import { esc, icon, $, $$, toast, copyText } from "../ui.js";
import { pickMime } from "../engine.js";

let root;

function render() {
  const p = prefs();
  const h = server.health;
  const mime = pickMime();
  root.querySelector("#setBody").innerHTML = `
    <div class="grid cols-2" style="align-items:start">
      <div class="card">
        <h3 class="section-title">Export</h3>
        <div class="label" style="margin-bottom:8px">Default quality</div>
        <div class="seg" data-pref="quality">${[["1080", "1080p"], ["720", "720p"]].map(([v, l]) => `<button data-v="${v}" class="${p.quality === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="label" style="margin-bottom:8px">Default frame rate</div>
        <div class="seg" data-pref="fps">${[30, 60].map((v) => `<button data-v="${v}" class="${Number(p.fps) === v ? "on" : ""}">${v} fps</button>`).join("")}</div>
        <p class="help">This browser records <b>${mime === null ? "nothing (unsupported)" : mime?.includes("webm") ? "WebM" : "MP4"}</b>${
          h?.ffmpeg ? " and the server converts every export to a clean H.264 MP4." : "."
        } Chrome and Edge record MP4 directly.</p>
      </div>

      <div class="card">
        <h3 class="section-title">Posting</h3>
        <label class="field"><span>Hashtag shortcuts</span><input class="input" id="prefTags" value="${esc(p.hashtags)}" placeholder="#clips #fyp"></label>
        <p class="help" style="margin:-8px 0 16px">Shown as one-tap chips under the caption on the Publish page.</p>
        <label class="field"><span>Default watermark</span><input class="input" id="prefWatermark" value="${esc(p.watermark)}" placeholder="@yourhandle"></label>
        <p class="help" style="margin:-8px 0 0">Added to new clips in the Studio (Look tab). Leave empty for none.</p>
      </div>

      <div class="card">
        <h3 class="section-title">Local server</h3>
        ${
          server.online
            ? `<div class="tips">
            <div><span class="dot ok"></span>Running · v${esc(h.version)}</div>
            <div><span class="dot ${h.ffmpeg ? "ok" : "warn"}"></span>ffmpeg ${h.ffmpeg ? "found" : "not found. Exports stay in the browser's format (install ffmpeg for MP4 conversion)"}</div>
            <div style="align-items:flex-start"><span class="dot ok" style="margin-top:7px"></span><span>Your data lives in <code>${esc(h.dataDir)}</code> <button class="icon-btn" data-copy="${esc(h.dataDir)}" title="Copy path" style="width:24px;height:24px;vertical-align:middle">${icon("copy")}</button></span></div>
          </div>`
            : `<p class="muted">Not running. Start it from the <code>clips</code> folder with <code>npm start</code>. The Studio still works without it, but clips only live in this tab and posting is off.</p>`
        }
      </div>

      <div class="card">
        <h3 class="section-title">About</h3>
        <p class="muted">Scannata Clips. Made for individuals, by individuals. A local studio for cutting long videos into short ones and getting them out there.</p>
        <div class="tips" style="margin-top:16px">
          <div><span class="kbd">Space</span>Play / pause in the Studio</div>
          <div><span class="kbd">S</span>Split at the playhead</div>
          <div><span class="kbd">I</span><span class="kbd">O</span>Trim start / end to the playhead</div>
          <div><span class="kbd">Ctrl E</span>Export</div>
        </div>
      </div>
    </div>`;
}

export default {
  mount(section) {
    root = section;
    section.innerHTML = `<div class="page-head"><div><span class="eyebrow">Settings</span><h1 class="page-title">Settings</h1></div></div><div id="setBody"></div>`;
    root.addEventListener("click", (e) => {
      const copy = e.target.closest("[data-copy]");
      if (copy) return copyText(copy.dataset.copy);
      const b = e.target.closest("[data-pref] button");
      if (!b) return;
      const key = b.parentElement.dataset.pref;
      setPrefs({ [key]: key === "fps" ? Number(b.dataset.v) : b.dataset.v });
      $$("button", b.parentElement).forEach((x) => x.classList.toggle("on", x === b));
      toast("Saved", { type: "ok", timeout: 1500 });
    });
    root.addEventListener("change", (e) => {
      if (e.target.id === "prefTags") setPrefs({ hashtags: e.target.value.trim() });
      else if (e.target.id === "prefWatermark") setPrefs({ watermark: e.target.value.trim() });
      else return;
      toast("Saved", { type: "ok", timeout: 1500 });
    });
  },
  async show() {
    await checkHealth();
    render();
  },
};
