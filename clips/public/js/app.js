// App shell: navigation, routing, server status and global drag & drop.
import { checkHealth, server, on, emit } from "./api.js";
import { $, $$, icon, esc, isVideoFile, toast, PLATFORMS } from "./ui.js";

const NAV = [
  { id: "home", label: "Home", icon: "home", group: "Create" },
  { id: "studio", label: "Studio", icon: "studio", group: "Create", key: "E" },
  { id: "library", label: "Library", icon: "library", group: "Create" },
  { id: "publish", label: "Publish", icon: "publish", group: "Share" },
  { id: "data", label: "Data", icon: "data", group: "Share" },
  { id: "accounts", label: "Accounts", icon: "accounts", group: "Setup" },
  { id: "settings", label: "Settings", icon: "settings", group: "Setup" },
];

const loaders = {
  home: () => import("./views/home.js"),
  studio: () => import("./views/studio.js"),
  library: () => import("./views/library.js"),
  publish: () => import("./views/publish.js"),
  data: () => import("./views/data.js"),
  accounts: () => import("./views/accounts.js"),
  settings: () => import("./views/settings.js"),
};

const mounted = new Map(); // id -> { section, view }
let current = null;

export function navigate(path) {
  location.hash = path.startsWith("#") ? path : `#/${path.replace(/^\//, "")}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [id, query = ""] = raw.split("?");
  return { id: loaders[id] ? id : "home", params: Object.fromEntries(new URLSearchParams(query)) };
}

async function route() {
  const { id, params } = parseHash();
  document.body.classList.remove("nav-open");
  $("#menuBtn").setAttribute("aria-expanded", "false");

  $$(".nav-item, .overlay-links a").forEach((a) => a.classList.toggle("active", a.dataset.nav === id));

  if (current && current !== id) {
    const prev = mounted.get(current);
    prev?.view.hide?.();
    prev?.section.classList.add("hidden");
  }

  let entry = mounted.get(id);
  if (!entry) {
    const section = document.createElement("section");
    section.className = "view";
    section.dataset.view = id;
    $("#main").appendChild(section);
    const mod = await loaders[id]();
    const view = mod.default;
    entry = { section, view };
    mounted.set(id, entry);
    await view.mount(section, ctx);
  }
  entry.section.classList.remove("hidden");
  // replay the entrance animation
  entry.section.style.animation = "none";
  void entry.section.offsetWidth;
  entry.section.style.animation = "";
  current = id;
  document.title = `${NAV.find((n) => n.id === id).label} · Scannata Clips`;
  await entry.view.show?.(params);
  if (id !== "studio") window.scrollTo({ top: 0 });
}

async function getView(id) {
  if (!mounted.get(id)) {
    const section = document.createElement("section");
    section.className = "view hidden";
    section.dataset.view = id;
    $("#main").appendChild(section);
    const view = (await loaders[id]()).default;
    mounted.set(id, { section, view });
    await view.mount(section, ctx);
  }
  return mounted.get(id).view;
}

export const ctx = { navigate, getView, server };

// ---------------------------------------------------------------- shell ---
function buildNav() {
  let group = "";
  let railHtml = "";
  for (const n of NAV) {
    if (n.group !== group) {
      group = n.group;
      railHtml += `<div class="nav-label">${group}</div>`;
    }
    railHtml += `<a class="nav-item" href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}<span>${n.label}</span>${
      n.id === "publish" ? `<span class="nav-badge hidden" id="publishBadge"></span>` : ""
    }</a>`;
  }
  $("#railNav").innerHTML = railHtml;
  $("#overlayLinks").innerHTML = NAV.map(
    (n, i) => `<a href="#/${n.id}" data-nav="${n.id}" style="transition-delay:${0.45 + i * 0.05}s">${n.label}</a>`
  ).join("");

  $("#menuBtn").addEventListener("click", () => {
    const open = !document.body.classList.contains("nav-open");
    document.body.classList.toggle("nav-open", open);
    $("#menuBtn").setAttribute("aria-expanded", String(open));
    $("#overlayNav").setAttribute("aria-hidden", String(!open));
  });
}

function renderFoot() {
  const foot = $("#railFoot");
  if (!server.checked) return;
  const acc = server.health?.accounts || {};
  foot.innerHTML = `
    <div class="status-line"><span class="dot ${server.online ? "ok" : "off"}"></span>${
      server.online ? "Local server running" : "Server offline, editing only"
    }</div>
    <div class="acct-chips">
      ${Object.values(PLATFORMS)
        .map(
          (p) =>
            `<a class="acct-chip ${acc[p.id] ? "on" : ""}" href="#/accounts" title="${p.name} ${acc[p.id] ? "connected" : "not connected"}">${icon(p.icon)}${
              acc[p.id]?.profile?.username ? `@${esc(acc[p.id].profile.username).slice(0, 12)}` : acc[p.id] ? "Linked" : "Link"
            }</a>`
        )
        .join("")}
    </div>`;
  const badge = $("#publishBadge");
  if (badge) {
    badge.classList.toggle("hidden", !server.health?.publishing);
    badge.textContent = "•";
  }
}

// --------------------------------------------------- global drag & drop ---
// Files dropped anywhere land in the Studio, except on the Library page where
// they are added to the library as finished clips.
function setupDrop() {
  const veil = $("#dropveil");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    const lib = current === "library";
    $("strong", veil).textContent = lib ? "Drop to add to Library" : "Drop to import";
    $("span", veil).textContent = lib ? "Finished videos, ready to post" : "Videos go straight into the Studio";
    veil.classList.add("show");
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) veil.classList.remove("show");
  });
  window.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.classList.remove("show");
    const files = [...e.dataTransfer.files].filter(isVideoFile);
    if (!files.length) return toast("That's not a video", { sub: "Drop MP4, MOV or WebM files", type: "err" });
    if (current === "library") return (await getView("library")).uploadFiles(files);
    openInStudio(files);
  });
}

export async function openInStudio(files) {
  const studio = await getView("studio");
  navigate("studio");
  studio.importFiles(files);
}
ctx.openInStudio = openInStudio;

// ----------------------------------------------------------------- boot ---
async function boot() {
  buildNav();
  setupDrop();
  on("health", renderFoot);
  on("accounts:changed", () => checkHealth());
  await checkHealth();
  window.addEventListener("hashchange", route);
  await route();
  setInterval(checkHealth, 15000);
  // the editor has unsaved work in memory
  window.addEventListener("beforeunload", (e) => {
    const studio = mounted.get("studio")?.view;
    if (studio?.isDirty?.()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  emit("ready");
}

boot();
