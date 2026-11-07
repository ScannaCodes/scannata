// Small UI toolkit: escaping, icons, formatting, toasts, modals.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const icon = (name, cls = "") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function html(strings, ...values) {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? values[i] ?? "" : ""), "");
}

export const PLATFORMS = {
  tiktok: { id: "tiktok", name: "TikTok", icon: "tiktok", color: "var(--series-tiktok)", hex: "#3987e5" },
  instagram: { id: "instagram", name: "Instagram", icon: "instagram", color: "var(--series-instagram)", hex: "#d95926" },
};

// ----------------------------------------------------------- formatting ---
export function compact(n) {
  if (n == null || Number.isNaN(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export const full = (n) => (n == null ? "–" : Math.round(n).toLocaleString());

export function duration(sec) {
  if (sec == null || !Number.isFinite(sec)) return "–:––";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// 0:12.4
export function timecode(sec) {
  if (!Number.isFinite(sec)) sec = 0;
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function bytes(n) {
  if (!n) return "–";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

export function ago(ts) {
  if (!ts) return "";
  const d = (Date.now() - ts) / 1000;
  if (d < 0) return `in ${ago(Date.now() + (Date.now() - ts)).replace(" ago", "")}`;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export const dateShort = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const dateTime = (ts) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// --------------------------------------------------------------- toasts ---
export function toast(title, { sub = "", type = "", timeout = 4200 } = {}) {
  const root = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div><strong>${esc(title)}</strong>${sub ? `<div class="muted">${esc(sub)}</div>` : ""}</div>`;
  root.appendChild(el);
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 260);
  };
  el.addEventListener("click", close);
  if (timeout) setTimeout(close, timeout);
  return close;
}

export const toastError = (err, title = "Something went wrong") => toast(title, { sub: err?.message || String(err), type: "err", timeout: 7000 });

// --------------------------------------------------------------- modals ---
export function modal({ title = "", body = "", actions = [], dismissable = true, width } = {}) {
  const root = document.getElementById("modalRoot");
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${width ? `style="width:min(${width}px,100%)"` : ""}>
    ${title ? `<h2>${esc(title)}</h2>` : ""}
    <div class="modal-body"></div>
    <div class="actions"></div>
  </div>`;
  const bodyEl = back.querySelector(".modal-body");
  if (typeof body === "string") bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const actionsEl = back.querySelector(".actions");
  const api = {
    el: back.querySelector(".modal"),
    body: bodyEl,
    close() {
      back.remove();
      document.removeEventListener("keydown", onKey);
      api.onclose?.();
    },
    setActions(list) {
      actionsEl.innerHTML = "";
      for (const a of list) {
        const b = document.createElement("button");
        b.className = `btn ${a.kind || ""}`;
        b.innerHTML = `${a.icon ? icon(a.icon) : ""}${esc(a.label)}`;
        b.addEventListener("click", () => a.onClick?.(api));
        actionsEl.appendChild(b);
      }
      actionsEl.classList.toggle("hidden", !list.length);
    },
  };
  const onKey = (e) => e.key === "Escape" && dismissable && api.close();
  document.addEventListener("keydown", onKey);
  back.addEventListener("mousedown", (e) => e.target === back && dismissable && api.close());
  api.setActions(actions);
  root.appendChild(back);
  return api;
}

export function confirmDialog(title, text, { ok = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p class="muted">${esc(text)}</p>`,
      actions: [
        { label: "Cancel", kind: "ghost", onClick: (m) => (m.close(), resolve(false)) },
        { label: ok, kind: danger ? "danger" : "primary", onClick: (m) => (m.close(), resolve(true)) },
      ],
    });
    m.onclose = () => resolve(false);
  });
}

export function promptDialog(title, value = "", { label = "Name", ok = "Save" } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<label class="field"><span>${esc(label)}</span><input class="input" value="${esc(value)}"></label>`,
      actions: [
        { label: "Cancel", kind: "ghost", onClick: (m) => (m.close(), resolve(null)) },
        { label: ok, kind: "primary", onClick: (m) => (m.close(), resolve(m.body.querySelector("input").value.trim())) },
      ],
    });
    const input = m.body.querySelector("input");
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        m.close();
        resolve(input.value.trim());
      }
    });
    m.onclose = () => resolve(null);
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied", { sub: text.length > 60 ? `${text.slice(0, 60)}…` : text, type: "ok", timeout: 2000 });
  } catch {
    toast("Copy failed", { sub: "Select the text and copy it by hand", type: "err" });
  }
}

export function download(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// keep the gold fill of range inputs in sync
export function paintRange(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const p = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty("--p", `${p}%`);
}

document.addEventListener("input", (e) => {
  if (e.target.matches?.('input[type="range"]')) paintRange(e.target);
});

export function paintRanges(root) {
  $$('input[type="range"]', root).forEach(paintRange);
}

export const isVideoFile = (f) => f && (f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
