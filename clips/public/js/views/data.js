// DATA: how your clips are doing across TikTok and Instagram.
import { server, getStats } from "../api.js";
import { demoStats } from "../demo.js";
import { lineChart, rankBars } from "../charts.js";
import { esc, icon, $, $$, compact, full, dateShort, ago, PLATFORMS, toastError } from "../ui.js";

let root;
let app;
let stats = null;
let platform = "all";
let range = 30;
let sort = { key: "createdAt", dir: -1 };

export async function loadStats(refresh = false) {
  const connected = Object.keys(server.health?.accounts || {});
  if (!server.online || !connected.length) return demoStats();
  return getStats(refresh);
}

const DAY = 86400000;

function filtered() {
  const since = range ? Date.now() - range * DAY : 0;
  return stats.posts.filter((p) => (platform === "all" || p.platform === platform) && p.createdAt >= since);
}

function previous() {
  if (!range) return [];
  const end = Date.now() - range * DAY;
  const start = end - range * DAY;
  return stats.posts.filter((p) => (platform === "all" || p.platform === platform) && p.createdAt >= start && p.createdAt < end);
}

const sum = (list, k) => list.reduce((s, p) => s + (p[k] || 0), 0);
const er = (list) => {
  const v = sum(list, "views");
  return v ? ((sum(list, "likes") + sum(list, "comments") + sum(list, "shares")) / v) * 100 : 0;
};

function delta(now, before) {
  if (!before) return "";
  const d = ((now - before) / before) * 100;
  if (!Number.isFinite(d)) return "";
  return `<span class="delta ${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(0)}%</span> vs previous ${range} days`;
}

function render() {
  const posts = filtered();
  const prev = previous();
  const accts = stats.accounts.filter((a) => platform === "all" || a.platform === platform);
  const followers = accts.reduce((s, a) => s + (a.followers || 0), 0);
  const errors = Object.entries(stats.errors || {});

  root.querySelector("#dataBody").innerHTML = `
    ${
      stats.demo
        ? `<div class="demo-banner">${icon("eye")}<span><b>Sample data.</b> ${
            server.online ? "Connect TikTok or Instagram to see your real numbers." : "Start the local server and connect an account to see your real numbers."
          }</span><span class="spacer"></span><a class="btn sm primary" href="#/accounts">${icon("accounts")}Connect accounts</a></div>`
        : ""
    }
    ${errors
      .map(([p, msg]) => `<div class="callout warn">${icon(PLATFORMS[p]?.icon || "x")}<span><b>${PLATFORMS[p]?.name || p}:</b> ${esc(msg)}</span></div>`)
      .join("")}

    <div class="grid cols-4" style="margin-bottom:20px">
      <div class="stat"><div class="stat-label">${icon("eye")}Views</div><div class="stat-value">${compact(sum(posts, "views"))}</div>
        <div class="stat-sub">${delta(sum(posts, "views"), sum(prev, "views")) || `${posts.length} clips`}</div></div>
      <div class="stat"><div class="stat-label">${icon("heart")}Engagement</div><div class="stat-value">${er(posts).toFixed(1)}%</div>
        <div class="stat-sub">${compact(sum(posts, "likes"))} likes · ${compact(sum(posts, "comments"))} comments · ${compact(sum(posts, "shares"))} shares</div></div>
      <div class="stat"><div class="stat-label">${icon("users")}Followers</div><div class="stat-value">${compact(followers)}</div>
        <div class="stat-sub">${accts.map((a) => `${PLATFORMS[a.platform].name} ${compact(a.followers)}`).join(" · ") || "No account connected"}</div></div>
      <div class="stat"><div class="stat-label">${icon("film")}Clips posted</div><div class="stat-value">${posts.length}</div>
        <div class="stat-sub">${posts.length ? `${compact(sum(posts, "views") / posts.length)} avg views per clip` : "Nothing in this range"}</div></div>
    </div>

    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr);margin-bottom:20px" id="rowA">
      <div class="card chart-card">
        <div class="chart-head"><h3>Views by posting day</h3><div class="legend" id="legendViews"></div></div>
        <div id="chartViews"></div>
      </div>
      <div class="card">
        <div class="chart-head"><h3>What works</h3></div>
        <div class="insights" id="insights"></div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-bottom:20px">
      <div class="card chart-card">
        <div class="chart-head"><h3>Follower growth</h3><div class="legend" id="legendFollowers"></div></div>
        <div id="chartFollowers"></div>
      </div>
      <div class="card">
        <div class="chart-head"><h3>Top clips</h3><span class="muted" style="font-size:12px">by views</span></div>
        <div id="topClips"></div>
      </div>
    </div>

    <div class="card" style="padding:22px 10px 10px">
      <div class="chart-head" style="padding:0 12px"><h3>Every clip</h3><span class="muted" style="font-size:12px">${posts.length} in range · click a column to sort</span></div>
      <div class="table-wrap" id="postTable"></div>
    </div>`;

  renderViewsChart(posts);
  renderFollowers();
  rankBars($("#topClips", root), posts, { max: 6 });
  renderInsights(posts);
  renderTable(posts);
  // stack the first row on narrow screens
  const rowA = $("#rowA", root);
  const mq = window.matchMedia("(max-width: 1100px)");
  rowA.style.gridTemplateColumns = mq.matches ? "1fr" : "minmax(0,2fr) minmax(0,1fr)";
}

function activePlatforms() {
  return platform === "all" ? ["tiktok", "instagram"].filter((p) => stats.posts.some((x) => x.platform === p) || stats.accounts.some((a) => a.platform === p)) : [platform];
}

function bucketSize() {
  return !range || range > 45 ? 7 : 1;
}

function renderViewsChart(posts) {
  const plats = activePlatforms();
  const b = bucketSize() * DAY;
  const start = range ? Date.now() - range * DAY : Math.min(...posts.map((p) => p.createdAt), Date.now() - 30 * DAY);
  const startDay = Math.floor(start / b) * b;
  const endDay = Math.floor(Date.now() / b) * b;
  const series = plats.map((pl) => {
    const map = new Map();
    for (let x = startDay; x <= endDay; x += b) map.set(x, 0);
    for (const p of posts.filter((p) => p.platform === pl)) {
      const k = Math.floor(p.createdAt / b) * b;
      map.set(k, (map.get(k) || 0) + p.views);
    }
    return { name: PLATFORMS[pl].name, color: PLATFORMS[pl].hex, points: [...map].map(([x, y]) => ({ x, y })) };
  });
  $("#legendViews", root).innerHTML =
    series.length > 1 ? series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("") : "";
  lineChart($("#chartViews", root), {
    series,
    tipTitle: (x) => (bucketSize() > 1 ? `Week of ${dateShort(x)}` : new Date(x).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })),
  });
}

function renderFollowers() {
  const plats = activePlatforms();
  const since = range ? Date.now() - range * DAY : 0;
  const hist = (stats.history || []).filter((h) => Date.parse(h.day) >= since - DAY);
  const series = plats
    .map((pl) => ({
      name: PLATFORMS[pl].name,
      color: PLATFORMS[pl].hex,
      points: hist.filter((h) => h[pl]?.followers != null).map((h) => ({ x: Date.parse(h.day), y: h[pl].followers })),
    }))
    .filter((s) => s.points.length);
  const el = $("#chartFollowers", root);
  $("#legendFollowers", root).innerHTML =
    series.length > 1 ? series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("") : "";
  if (!series.some((s) => s.points.length > 1)) {
    el.innerHTML = `<div class="empty" style="padding:36px 20px"><h3>Tracking started</h3><p>Follower counts are saved once a day while the studio is open. Growth shows up here after a couple of days.</p></div>`;
    return;
  }
  // Instagram and TikTok audiences differ in size: index both to 100 so the
  // shapes compare honestly on one axis.
  const indexed = series.length > 1;
  const shown = indexed
    ? series.map((s) => ({ ...s, raw: s.points, points: s.points.map((p) => ({ x: p.x, y: (p.y / s.points[0].y) * 100 })) }))
    : series;
  lineChart(el, {
    series: shown,
    height: 240,
    zero: false,
    yFormat: indexed ? (v) => (Math.abs(v - Math.round(v)) < 0.05 ? v.toFixed(0) : v.toFixed(1)) : compact,
    tipTitle: (x) => `${dateShort(x)}${indexed ? " · indexed, first day = 100" : ""}`,
  });
  if (indexed) el.insertAdjacentHTML("beforeend", `<p class="help" style="margin-top:6px">Indexed to 100 on the first day so both accounts compare on one scale. Hover for details.</p>`);
}

function renderInsights(posts) {
  const el = $("#insights", root);
  if (posts.length < 3) {
    el.innerHTML = `<p class="muted" style="font-size:13px">Post a few more clips and patterns show up here: best time, best day, what length works.</p>`;
    return;
  }
  const avg = (list) => (list.length ? sum(list, "views") / list.length : 0);
  const byHour = new Map();
  const byDay = new Map();
  for (const p of posts) {
    const d = new Date(p.createdAt);
    const slot = Math.floor(d.getHours() / 3) * 3;
    byHour.set(slot, [...(byHour.get(slot) || []), p]);
    byDay.set(d.getDay(), [...(byDay.get(d.getDay()) || []), p]);
  }
  const best = (map) => [...map].filter(([, l]) => l.length >= 2).sort((a, b) => avg(b[1]) - avg(a[1]))[0] || [...map].sort((a, b) => avg(b[1]) - avg(a[1]))[0];
  const [h, hList] = best(byHour);
  const [d, dList] = best(byDay);
  const fmtH = (x) => new Date(2000, 0, 1, x).toLocaleTimeString(undefined, { hour: "numeric" });
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const overall = avg(posts);
  const tags = new Map();
  for (const p of posts) for (const t of (p.title || "").match(/#[\p{L}0-9_]+/gu) || []) tags.set(t.toLowerCase(), [...(tags.get(t.toLowerCase()) || []), p]);
  const topTag = [...tags].filter(([, l]) => l.length >= 2).sort((a, b) => avg(b[1]) - avg(a[1]))[0];
  const lift = (l) => {
    const x = (avg(l) / overall - 1) * 100;
    return `${x >= 0 ? "+" : ""}${x.toFixed(0)}% vs your average`;
  };
  el.innerHTML = `
    <div class="insight"><div class="ico">${icon("clock")}</div><div><b>${fmtH(h)}–${fmtH((h + 3) % 24)}</b><span>Best time to post · ${lift(hList)}</span></div></div>
    <div class="insight"><div class="ico">${icon("bolt")}</div><div><b>${days[d]}</b><span>Best day · ${lift(dList)}</span></div></div>
    <div class="insight"><div class="ico">${icon("eye")}</div><div><b>${compact(overall)}</b><span>Average views per clip</span></div></div>
    ${topTag ? `<div class="insight"><div class="ico">${icon("magnet")}</div><div><b>${esc(topTag[0])}</b><span>Strongest hashtag · ${lift(topTag[1])}</span></div></div>` : ""}`;
}

function renderTable(posts) {
  const cols = [
    ["platform", "", false],
    ["title", "Clip", false],
    ["createdAt", "Posted", true],
    ["views", "Views", true],
    ["likes", "Likes", true],
    ["comments", "Comments", true],
    ["shares", "Shares", true],
    ["er", "Eng.", true],
  ];
  const rows = posts
    .map((p) => ({ ...p, er: p.views ? ((p.likes + p.comments + p.shares) / p.views) * 100 : 0 }))
    .sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * sort.dir;
    });
  $("#postTable", root).innerHTML = rows.length
    ? `<table class="data"><thead><tr>${cols
        .map(([k, l, num]) => `<th data-sort="${k}" class="${num ? "num" : ""} ${sort.key === k ? "sorted" : ""}">${l}${sort.key === k ? (sort.dir > 0 ? " ↑" : " ↓") : ""}</th>`)
        .join("")}</tr></thead><tbody>${rows
        .map(
          (p) => `<tr>
          <td title="${PLATFORMS[p.platform].name}" style="color:${PLATFORMS[p.platform].hex}">${icon(PLATFORMS[p.platform].icon)}</td>
          <td class="title">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</td>
          <td class="num muted">${dateShort(p.createdAt)}</td>
          <td class="num">${full(p.views)}</td>
          <td class="num">${full(p.likes)}</td>
          <td class="num">${full(p.comments)}</td>
          <td class="num">${full(p.shares)}</td>
          <td class="num">${p.er.toFixed(1)}%</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="empty" style="margin:10px">No clips posted in this range.</div>`;
}

async function load(refresh = false) {
  const btn = $("#refreshStats", root);
  btn.disabled = true;
  btn.innerHTML = `${icon("refresh")}Loading…`;
  try {
    stats = await loadStats(refresh);
    $("#updated", root).textContent = stats.demo ? "Sample data" : `Updated ${ago(stats.generatedAt)}`;
    render();
  } catch (err) {
    toastError(err, "Couldn't load stats");
    if (!stats) {
      stats = demoStats();
      render();
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon("refresh")}Refresh`;
  }
}

export default {
  mount(section, ctx) {
    app = ctx;
    root = section;
    section.innerHTML = `
      <div class="page-head">
        <div><span class="eyebrow">Data</span><h1 class="page-title">How your clips do</h1></div>
        <div class="row"><span class="muted" style="font-size:12px" id="updated"></span><button class="btn sm" id="refreshStats">${icon("refresh")}Refresh</button></div>
      </div>
      <div class="data-filters">
        <div class="pills" id="platPills">
          <button class="pill on" data-p="all">All</button>
          <button class="pill" data-p="tiktok">${icon("tiktok")}TikTok</button>
          <button class="pill" data-p="instagram">${icon("instagram")}Instagram</button>
        </div>
        <div class="pills" id="rangePills">
          ${[[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "All time"]]
            .map(([v, l]) => `<button class="pill ${v === range ? "on" : ""}" data-r="${v}">${l}</button>`)
            .join("")}
        </div>
      </div>
      <div id="dataBody"></div>`;
    $("#platPills", root).addEventListener("click", (e) => {
      const b = e.target.closest("[data-p]");
      if (!b) return;
      platform = b.dataset.p;
      $$("#platPills .pill", root).forEach((x) => x.classList.toggle("on", x === b));
      render();
    });
    $("#rangePills", root).addEventListener("click", (e) => {
      const b = e.target.closest("[data-r]");
      if (!b) return;
      range = Number(b.dataset.r);
      $$("#rangePills .pill", root).forEach((x) => x.classList.toggle("on", x === b));
      render();
    });
    $("#refreshStats", root).addEventListener("click", () => load(true));
    root.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th || !th.dataset.sort || th.dataset.sort === "platform") return;
      const k = th.dataset.sort;
      sort = { key: k, dir: sort.key === k ? -sort.dir : -1 };
      renderTable(filtered());
    });
  },
  async show() {
    await load(false);
  },
};
