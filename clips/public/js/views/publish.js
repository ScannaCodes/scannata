// PUBLISH: send a clip to TikTok and Instagram, now or later.
import { listClips, listPosts, createPosts, cancelPost, retryPost, tiktokCreator, server, prefs, on, emit } from "../api.js";
import { esc, icon, $, $$, duration, ago, dateTime, toast, toastError, PLATFORMS } from "../ui.js";
import { clipCard, wireHoverPreview } from "./library.js";

let root;
let app;
let clips = [];
let posts = [];
let selected = null;
let showAll = false;
let creator = null;
let creatorErr = null;
let pollTimer = null;
let visible = false;

const STATUS = {
  scheduled: ["Scheduled", "gold"],
  queued: ["Waiting", ""],
  uploading: ["Uploading", "warn"],
  processing: ["Processing", "warn"],
  published: ["Posted", "ok"],
  failed: ["Failed", "err"],
};

const PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

function accounts() {
  return server.health?.accounts || {};
}

function renderOffline() {
  root.querySelector("#pubBody").innerHTML = `<div class="empty"><h3>The local server isn't running</h3>
    <p>Posting needs it. Open a terminal in the <code>clips</code> folder and run <code>npm start</code>, then reload.</p></div>`;
}

function renderClips() {
  const grid = $("#pickGrid", root);
  if (!clips.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>No clips yet</h3><p>Export one from the Studio first.</p><a class="btn primary" href="#/studio">${icon("studio")}Open Studio</a></div>`;
    return;
  }
  const list = showAll ? clips : clips.slice(0, 8);
  grid.innerHTML = list.map((c) => clipCard(c, { selectable: true, selected: c.id === selected, actions: false })).join("");
  $("#showAll", root).classList.toggle("hidden", clips.length <= 8);
  $("#showAll", root).textContent = showAll ? "Show fewer" : `Show all ${clips.length}`;
}

function platformCard(id) {
  const p = PLATFORMS[id];
  const acc = accounts()[id];
  if (!acc) {
    return `<div class="platform-card"><div class="platform-head">
      <div class="plat-icon">${icon(p.icon)}</div>
      <div><div class="pname">${p.name}</div><div class="psub">Not connected</div></div>
      <span class="spacer"></span><a class="btn sm" href="#/accounts">Connect</a></div></div>`;
  }
  const name = acc.profile?.username ? `@${esc(acc.profile.username)}` : "Connected";
  const body =
    id === "tiktok"
      ? `<div class="platform-body">
          <div class="label" style="margin:14px 0 8px">How</div>
          <div class="seg" data-seg="ttMode"><button data-v="direct" class="on">Post directly</button><button data-v="draft">Send to TikTok drafts</button></div>
          <div id="ttDirect">
            <label class="field"><span>Who can watch</span>
              <select class="input" id="ttPrivacy">${
                creator
                  ? `<option value="" selected disabled>Choose who can see this</option>${(creator.privacy_level_options || [])
                      .map((o) => `<option value="${o}">${PRIVACY_LABELS[o] || o}</option>`)
                      .join("")}`
                  : `<option value="">${creatorErr ? "Couldn't load options" : "Loading…"}</option>`
              }</select></label>
            ${creatorErr ? `<p class="help" style="color:var(--err);margin:-8px 0 12px">${esc(creatorErr)}</p>` : ""}
            <label class="check"><input type="checkbox" id="ttComment" ${creator?.comment_disabled ? "disabled" : "checked"}>Allow comments</label>
            <label class="check"><input type="checkbox" id="ttDuet" ${creator?.duet_disabled ? "disabled" : "checked"}>Allow Duet</label>
            <label class="check"><input type="checkbox" id="ttStitch" ${creator?.stitch_disabled ? "disabled" : "checked"}>Allow Stitch</label>
            <div class="divider" style="margin:12px 0"></div>
            <label class="check"><input type="checkbox" id="ttBrandOrganic">Promotes my own brand or business</label>
            <label class="check"><input type="checkbox" id="ttBrandContent">Paid partnership / branded content</label>
            <label class="check"><input type="checkbox" id="ttAigc">Made with AI</label>
            <p class="help" style="margin-top:10px">By posting you agree to TikTok's <a class="link" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>. Apps that haven't passed TikTok's review can only post as "Only me".</p>
          </div>
          <p class="help hidden" id="ttDraftNote" style="margin-top:4px">The video lands in your TikTok inbox. Open the app to add sounds and post it.</p>
        </div>`
      : `<div class="platform-body">
          <label class="check" style="margin-top:12px"><input type="checkbox" id="igFeed" checked>Also show in the main feed grid</label>
          <p class="help" style="margin-top:8px">Posts as a Reel. Needs a Business or Creator account. 3–90 second MP4 works best.</p>
        </div>`;
  return `<div class="platform-card on" data-plat="${id}">
    <div class="platform-head">
      <div class="plat-icon">${icon(p.icon)}</div>
      <div><div class="pname">${p.name}</div><div class="psub">${name}</div></div>
      <span class="spacer"></span>
      <span class="switch"><input type="checkbox" data-enable="${id}" checked><i></i></span>
    </div>${body}</div>`;
}

function renderForm() {
  const tags = (prefs().hashtags || "").split(/\s+/).filter((t) => t.startsWith("#"));
  const now = new Date(Date.now() + 3600000);
  now.setMinutes(0, 0, 0);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("#pubForm", root).innerHTML = `
    <h3 class="section-title">Caption</h3>
    <label class="field"><textarea class="input" id="caption" maxlength="2200" placeholder="Say what happens. First line is the hook."></textarea></label>
    <div class="char-count num" id="capCount">0 / 2200</div>
    ${tags.length ? `<div class="hashtags">${tags.map((t) => `<button data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
    <h3 class="section-title" style="margin-top:8px">Where</h3>
    ${platformCard("tiktok")}
    ${platformCard("instagram")}
    <h3 class="section-title" style="margin-top:20px">When</h3>
    <div class="seg" data-seg="when"><button data-v="now" class="on">Now</button><button data-v="later">${icon("clock")}Schedule</button></div>
    <div class="hidden" id="schedWrap">
      <label class="field"><span>Date and time</span><input class="input" type="datetime-local" id="schedAt" value="${local}"></label>
      <p class="help" style="margin:-8px 0 14px">Scheduled posts go out while the studio server is running on this computer.</p>
    </div>
    <button class="btn primary lg" style="width:100%" id="postBtn">${icon("publish")}Post clip</button>`;
}

function renderPosts() {
  const el = $("#postList", root);
  if (!posts.length) {
    el.innerHTML = `<p class="muted" style="font-size:13px">Nothing posted from here yet.</p>`;
    return;
  }
  el.innerHTML = posts
    .slice(0, 30)
    .map((p) => {
      const [label, cls] = STATUS[p.status] || [p.status, ""];
      const when =
        p.status === "scheduled" ? `for ${dateTime(p.scheduledAt)}` : p.publishedAt ? ago(p.publishedAt) : ago(p.updatedAt || p.createdAt);
      return `<div class="post-row">
        <div class="plat-icon">${icon(PLATFORMS[p.platform].icon)}</div>
        <div style="min-width:0">
          <div class="title">${esc(p.clipName || "Clip")}</div>
          <div class="sub"><span class="badge ${cls}">${label}</span> ${esc(p.stage && p.status !== "failed" ? p.stage : "")} · ${when}</div>
          ${p.error ? `<div class="err-text">${esc(p.error)}</div>` : ""}
        </div>
        <div class="row" style="gap:4px">
          ${p.url ? `<a class="icon-btn" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open post">${icon("external")}</a>` : ""}
          ${p.status === "failed" ? `<button class="btn sm" data-retry="${p.id}">Retry</button>` : ""}
          ${["scheduled", "queued"].includes(p.status) ? `<button class="btn sm ghost" data-cancel="${p.id}">Cancel</button>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

async function loadPosts() {
  try {
    posts = await listPosts();
    renderPosts();
  } catch {
    /* server may have gone away */
  }
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!visible) return;
  const busy = posts.some((p) => ["queued", "uploading", "processing"].includes(p.status));
  pollTimer = setTimeout(async () => {
    const before = posts.filter((p) => p.status === "published").length;
    await loadPosts();
    const after = posts.filter((p) => p.status === "published").length;
    if (after > before) {
      toast("Posted!", { sub: "Your clip is live. Numbers show up in Data shortly.", type: "ok" });
      emit("clips:changed");
    }
  }, busy ? 2500 : 15000);
}

async function loadCreator() {
  if (!accounts().tiktok) return;
  try {
    creator = await tiktokCreator();
    creatorErr = null;
  } catch (err) {
    creator = null;
    creatorErr = err.message;
  }
  const card = $('[data-plat="tiktok"]', root);
  if (card) {
    const keep = collectTikTok();
    card.outerHTML = platformCard("tiktok");
    restoreTikTok(keep);
  }
}

function collectTikTok() {
  const g = (id) => $(`#${id}`, root);
  if (!g("ttComment")) return null;
  return {
    mode: $('[data-seg="ttMode"] .on', root)?.dataset.v || "direct",
    privacy: g("ttPrivacy")?.value || "",
    allowComment: g("ttComment").checked,
    allowDuet: g("ttDuet").checked,
    allowStitch: g("ttStitch").checked,
    brandOrganic: g("ttBrandOrganic").checked,
    brandContent: g("ttBrandContent").checked,
    aigc: g("ttAigc").checked,
  };
}

function restoreTikTok(s) {
  if (!s) return;
  const g = (id) => $(`#${id}`, root);
  $$('[data-seg="ttMode"] button', root).forEach((b) => b.classList.toggle("on", b.dataset.v === s.mode));
  toggleTtMode(s.mode);
  if (s.privacy && g("ttPrivacy").querySelector(`option[value="${s.privacy}"]`)) g("ttPrivacy").value = s.privacy;
  if (!g("ttComment").disabled) g("ttComment").checked = s.allowComment;
  if (!g("ttDuet").disabled) g("ttDuet").checked = s.allowDuet;
  if (!g("ttStitch").disabled) g("ttStitch").checked = s.allowStitch;
  g("ttBrandOrganic").checked = s.brandOrganic;
  g("ttBrandContent").checked = s.brandContent;
  g("ttAigc").checked = s.aigc;
}

function toggleTtMode(mode) {
  $("#ttDirect", root)?.classList.toggle("hidden", mode === "draft");
  $("#ttDraftNote", root)?.classList.toggle("hidden", mode !== "draft");
}

async function submit() {
  if (!selected) return toast("Pick a clip first", { type: "err" });
  const clip = clips.find((c) => c.id === selected);
  if (clip?.status === "processing") return toast("Still converting", { sub: "Give it a few seconds, then post.", type: "err" });
  const caption = $("#caption", root).value.trim();
  const platforms = {};
  const on = (id) => $(`[data-enable="${id}"]`, root)?.checked;

  if (on("tiktok")) {
    const s = collectTikTok();
    if (s.mode === "direct" && !s.privacy) return toast("Choose who can watch on TikTok", { type: "err" });
    if (s.mode === "direct" && s.brandContent && s.privacy === "SELF_ONLY") {
      return toast("Branded content can't be private", { sub: "TikTok requires branded content to be visible to others.", type: "err" });
    }
    platforms.tiktok = {
      mode: s.mode,
      privacy: s.privacy,
      disableComment: !s.allowComment,
      disableDuet: !s.allowDuet,
      disableStitch: !s.allowStitch,
      brandOrganic: s.brandOrganic,
      brandContent: s.brandContent,
      aiGenerated: s.aigc,
    };
  }
  if (on("instagram")) {
    if (clip && !(clip.mime || "").includes("mp4")) {
      return toast("Instagram needs MP4", { sub: "Install ffmpeg (see README) so exports are converted, or export from Chrome / Edge.", type: "err" });
    }
    platforms.instagram = { shareToFeed: $("#igFeed", root).checked };
  }
  if (!Object.keys(platforms).length) return toast("Turn on at least one platform", { type: "err" });

  const later = $('[data-seg="when"] .on', root)?.dataset.v === "later";
  let scheduleAt = null;
  if (later) {
    const v = $("#schedAt", root).value;
    if (!v || new Date(v).getTime() < Date.now() + 60000) return toast("Pick a time at least a minute from now", { type: "err" });
    scheduleAt = new Date(v).toISOString();
  }

  const btn = $("#postBtn", root);
  btn.disabled = true;
  try {
    await createPosts({ clipId: selected, caption, platforms, scheduleAt });
    toast(later ? "Scheduled" : "Posting started", {
      sub: later ? `Goes out ${dateTime(Date.parse(scheduleAt))}` : "Follow progress in the list below.",
      type: "ok",
    });
    $("#caption", root).value = "";
    $("#capCount", root).textContent = "0 / 2200";
    await loadPosts();
  } catch (err) {
    toastError(err, "Couldn't post");
  } finally {
    btn.disabled = false;
  }
}

function bindForm() {
  const form = $("#pubForm", root);
  form.addEventListener("input", (e) => {
    if (e.target.id === "caption") $("#capCount", root).textContent = `${e.target.value.length} / 2200`;
    if (e.target.dataset.enable) e.target.closest(".platform-card").classList.toggle("on", e.target.checked);
  });
  form.addEventListener("click", (e) => {
    const tag = e.target.closest("[data-tag]");
    if (tag) {
      const ta = $("#caption", root);
      if (!ta.value.includes(tag.dataset.tag)) ta.value = `${ta.value.trimEnd()}${ta.value ? " " : ""}${tag.dataset.tag}`;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const b = e.target.closest(".seg button");
    if (!b) return;
    const group = b.parentElement.dataset.seg;
    $$("button", b.parentElement).forEach((x) => x.classList.toggle("on", x === b));
    if (group === "when") $("#schedWrap", root).classList.toggle("hidden", b.dataset.v !== "later");
    if (group === "ttMode") toggleTtMode(b.dataset.v);
  });
  form.addEventListener("click", (e) => e.target.closest("#postBtn") && submit());
}

async function refresh() {
  if (!server.online) return renderOffline();
  try {
    clips = (await listClips()).filter((c) => !c.local);
  } catch (err) {
    toastError(err);
  }
  if (selected && !clips.find((c) => c.id === selected)) selected = null;
  if (!selected && clips[0]) selected = clips[0].id;
  renderClips();
}

let built = false;

function build(view) {
  root.querySelector("#pubBody").innerHTML = `
    <div class="publish">
      <div>
        <div class="section-head"><h3 class="section-title">Clip</h3><button class="btn sm ghost hidden" id="showAll"></button></div>
        <div class="pick-grid" id="pickGrid"></div>
        <h3 class="section-title" style="margin-top:44px">Queue and history</h3>
        <div class="post-list" id="postList"></div>
      </div>
      <div class="card" id="pubForm" style="position:sticky;top:20px"></div>
    </div>`;
  built = true;
  renderForm();
  bindForm();
  const grid = $("#pickGrid", root);
  wireHoverPreview(grid);
  grid.addEventListener("click", (e) => {
    const card = e.target.closest("[data-clip]");
    if (!card) return;
    selected = card.dataset.clip;
    renderClips();
  });
  $("#showAll", root).addEventListener("click", () => {
    showAll = !showAll;
    renderClips();
  });
  $("#postList", root).addEventListener("click", async (e) => {
    const r = e.target.closest("[data-retry]");
    const c = e.target.closest("[data-cancel]");
    try {
      if (r) await retryPost(r.dataset.retry);
      if (c) await cancelPost(c.dataset.cancel);
      if (r || c) await loadPosts();
    } catch (err) {
      toastError(err);
    }
  });
  view._accKey = JSON.stringify(Object.keys(accounts()));
}

export default {
  mount(section, ctx) {
    app = ctx;
    root = section;
    section.innerHTML = `
      <div class="page-head">
        <div><span class="eyebrow">Publish</span><h1 class="page-title">Post it</h1>
        <p class="lede">Pick a clip, write the caption, choose where. Post now or schedule it.</p></div>
        <a class="btn ghost" href="#/accounts">${icon("accounts")}Manage accounts</a>
      </div>
      <div id="pubBody"></div>`;
    on("clips:changed", () => visible && built && refresh());
    on("health", () => {
      if (!visible) return;
      if (!server.online) {
        built = false;
        return renderOffline();
      }
      if (!built) return this.show({});
      // accounts may have changed: rebuild the platform cards
      const key = JSON.stringify(Object.keys(accounts()));
      if (key !== this._accKey) {
        this._accKey = key;
        const caption = $("#caption", root)?.value || "";
        renderForm();
        $("#caption", root).value = caption;
        loadCreator();
      }
    });
  },
  async show(params = {}) {
    visible = true;
    if (!server.online) {
      built = false;
      return renderOffline();
    }
    if (!built) build(this);
    if (params.clip) selected = params.clip;
    await refresh();
    loadPosts();
    loadCreator();
    if (params.clip) $("#caption", root)?.focus();
  },
  hide() {
    visible = false;
    clearTimeout(pollTimer);
  },
};
