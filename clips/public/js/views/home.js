// HOME: start a clip, see what's happening.
import { listClips, server, on } from "../api.js";
import { esc, icon, $, compact, ago, PLATFORMS } from "../ui.js";
import { clipCard, wireHoverPreview } from "./library.js";
import { loadStats } from "./data.js";

let root;
let app;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Late night session" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

async function renderStats() {
  const el = $("#homeStats", root);
  try {
    const s = await loadStats(false);
    const week = Date.now() - 7 * 86400000;
    const recent = s.posts.filter((p) => p.createdAt >= week);
    const views = recent.reduce((a, p) => a + p.views, 0);
    const followers = s.accounts.reduce((a, x) => a + (x.followers || 0), 0);
    const top = s.posts.slice().sort((a, b) => b.views - a.views)[0];
    el.innerHTML = `
      <div class="stat"><div class="stat-label">${icon("eye")}Views · 7 days</div><div class="stat-value">${compact(views)}</div><div class="stat-sub">${recent.length} clips posted</div></div>
      <div class="stat"><div class="stat-label">${icon("users")}Followers</div><div class="stat-value">${compact(followers)}</div><div class="stat-sub">${
        s.accounts.map((a) => `${PLATFORMS[a.platform].name} ${compact(a.followers)}`).join(" · ") || "Connect an account"
      }</div></div>
      <div class="stat"><div class="stat-label">${icon("bolt")}Best clip</div><div class="stat-value">${top ? compact(top.views) : "–"}</div><div class="stat-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${
        top ? esc(top.title) : "Nothing posted yet"
      }</div></div>
      <div class="stat"><div class="stat-label">${icon("data")}Source</div><div class="stat-value" style="font-size:28px;margin-top:16px">${s.demo ? "Sample" : "Live"}</div><div class="stat-sub">${
        s.demo ? `<a class="link" href="#/accounts">Connect accounts</a> for real numbers` : `<a class="link" href="#/data">Open Data</a>`
      }</div></div>`;
  } catch {
    el.innerHTML = "";
  }
}

async function renderRecent() {
  const el = $("#homeRecent", root);
  let clips = [];
  try {
    clips = await listClips();
  } catch {
    /* offline */
  }
  el.innerHTML = clips.length
    ? clips.slice(0, 6).map((c) => clipCard(c, { actions: false })).join("")
    : `<div class="empty" style="grid-column:1/-1;padding:30px">Exported clips show up here.</div>`;
}

function renderAccounts() {
  const acc = server.health?.accounts || {};
  $("#homeAccounts", root).innerHTML = Object.values(PLATFORMS)
    .map((p) => {
      const a = acc[p.id];
      return `<div class="acct-row">
        ${a?.profile?.avatar ? `<img class="avatar" src="${esc(a.profile.avatar)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${icon(p.icon)}</div>`}
        <div style="flex:1;min-width:0"><div style="font-weight:600">${p.name}</div>
          <div class="muted" style="font-size:12px">${a ? `${a.profile?.username ? `@${esc(a.profile.username)}` : "Connected"}` : "Not connected"}</div></div>
        ${a ? `<span class="badge ok">${icon("check")}Linked</span>` : `<a class="btn sm" href="#/accounts">Link</a>`}
      </div>`;
    })
    .join("");
}

export default {
  mount(section, ctx) {
    app = ctx;
    root = section;
    const words = ["Cut it", "Post it", "Grow it", "Made for individuals", "By individuals", "Scannata"];
    section.innerHTML = `
      <div class="hero">
        <div>
          <span class="eyebrow" id="greet"></span>
          <h1 class="hero-title">Cut it.<br><span class="outline">Post it.</span><br>Grow it<span class="dotgold">.</span></h1>
          <p class="lede">Drop in a long video, find the moment, frame it vertical, caption it. Then send it to TikTok and Instagram and watch how it does, all from here.</p>
          <div class="hero-actions">
            <a class="btn primary lg" href="#/studio">${icon("studio")}Open the Studio</a>
            <a class="btn lg" href="#/data">${icon("data")}See your numbers</a>
          </div>
        </div>
        <label class="dropzone" id="homeDrop">
          <div class="dz-icon">${icon("upload")}</div>
          <strong>Drop a video here</strong>
          <span>or click to choose · MP4, MOV, WebM</span>
          <input type="file" accept="video/*,.mkv" multiple>
        </label>
      </div>

      <div class="marquee" aria-hidden="true"><div class="marquee-track">${[...words, ...words, ...words, ...words].map((w) => `<span>${w}</span><span>✦</span>`).join("")}</div></div>

      <div class="grid cols-4" id="homeStats" style="margin-bottom:48px"></div>

      <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:32px" id="homeRow">
        <div>
          <div class="section-head"><h2 class="section-title">Latest clips</h2><a class="btn sm ghost" href="#/library">All clips</a></div>
          <div class="clip-strip" id="homeRecent"></div>
        </div>
        <div class="stack" style="gap:28px">
          <div>
            <h2 class="section-title">Accounts</h2>
            <div id="homeAccounts"></div>
          </div>
          <div>
            <h2 class="section-title">Clipping tips</h2>
            <div class="tips">
              <div>${icon("bolt")}<span>Hook in the first 2 seconds. Add a <b>Hook title</b> in Text.</span></div>
              <div>${icon("comment")}<span>Most people watch muted. Caption everything.</span></div>
              <div>${icon("clock")}<span>15–45 seconds gets watched to the end most.</span></div>
              <div>${icon("frame")}<span>Turn on safe zones so text dodges the app buttons.</span></div>
            </div>
          </div>
        </div>
      </div>`;

    $("#homeDrop input", root).addEventListener("change", (e) => {
      ctx.openInStudio([...e.target.files]);
      e.target.value = "";
    });
    const dz = $("#homeDrop", root);
    dz.addEventListener("dragover", () => dz.classList.add("over"));
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", () => dz.classList.remove("over"));
    wireHoverPreview($("#homeRecent", root));
    $("#homeRecent", root).addEventListener("click", (e) => e.target.closest("[data-clip]") && app.navigate("library"));
    on("health", () => root.isConnected && renderAccounts());
    on("clips:changed", () => root.isConnected && renderRecent());
    const mq = window.matchMedia("(max-width: 1100px)");
    const fit = () => ($("#homeRow", root).style.gridTemplateColumns = mq.matches ? "1fr" : "minmax(0,2fr) minmax(0,1fr)");
    mq.addEventListener("change", fit);
    fit();
  },
  async show() {
    $("#greet", root).textContent = greeting();
    renderAccounts();
    renderRecent();
    renderStats();
  },
};
