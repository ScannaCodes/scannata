// Talks to the local server. When the server is not running (for example if
// the page is opened as a static file), the studio still works and exported
// clips are kept in memory for this session.

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

export const server = { online: false, health: null, checked: false };

async function request(method, url, body, { raw = false, headers = {} } = {}) {
  const opts = { method, headers: { "X-Clips": "1", ...headers } };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error("Can't reach the local server. Is `npm start` running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function checkHealth() {
  const was = server.online;
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (!data.ok) throw new Error();
    server.online = true;
    server.health = data;
  } catch {
    server.online = false;
    server.health = null;
  }
  server.checked = true;
  emit("health", server);
  if (was !== server.online) emit("clips:changed");
  return server;
}

// ------------------------------------------------------------- library ---
const localClips = [];

export async function listClips() {
  if (!server.online) return localClips.slice();
  return request("GET", "/api/clips");
}

// Uploads with progress (fetch has no upload progress, so XHR it is).
export function saveClip(blob, meta = {}, onProgress) {
  if (!server.online) {
    const id = `local_${Date.now().toString(36)}`;
    const clip = {
      id,
      name: meta.name || "Untitled clip",
      url: URL.createObjectURL(blob),
      thumbUrl: meta.thumbBlob ? URL.createObjectURL(meta.thumbBlob) : null,
      size: blob.size,
      mime: blob.type,
      duration: meta.duration || null,
      width: meta.width || null,
      height: meta.height || null,
      createdAt: Date.now(),
      status: "ready",
      posted: {},
      local: true,
      blob,
    };
    localClips.unshift(clip);
    emit("clips:changed");
    return Promise.resolve(clip);
  }
  const qs = new URLSearchParams();
  for (const k of ["name", "duration", "width", "height", "source"]) if (meta[k] != null) qs.set(k, meta[k]);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/clips?${qs}`);
    xhr.setRequestHeader("X-Clips", "1");
    xhr.setRequestHeader("Content-Type", (blob.type || "video/mp4").split(";")[0]);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = async () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 300) return reject(new Error(data.error || `Upload failed (${xhr.status})`));
      if (meta.thumbBlob) {
        try {
          data = await request("POST", `/api/clips/${data.id}/thumb`, meta.thumbBlob, { raw: true, headers: { "Content-Type": "image/jpeg" } });
        } catch {
          /* the clip is saved; a thumbnail is optional */
        }
      }
      emit("clips:changed");
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Upload failed. Is the local server running?"));
    xhr.send(blob);
  });
}

export async function renameClip(id, name) {
  const local = localClips.find((c) => c.id === id);
  if (local) {
    local.name = name;
    emit("clips:changed");
    return local;
  }
  const out = await request("PATCH", `/api/clips/${id}`, { name });
  emit("clips:changed");
  return out;
}

export async function deleteClip(id) {
  const i = localClips.findIndex((c) => c.id === id);
  if (i >= 0) {
    URL.revokeObjectURL(localClips[i].url);
    localClips.splice(i, 1);
    emit("clips:changed");
    return;
  }
  await request("DELETE", `/api/clips/${id}`);
  emit("clips:changed");
}

// ------------------------------------------------------------ accounts ---
export const getSettings = () => request("GET", "/api/settings");
export const saveSettings = (patch) => request("POST", "/api/settings", patch);
export const getAccounts = () => request("GET", "/api/accounts");
export const disconnect = (platform) => request("DELETE", `/api/accounts/${platform}`);
export const refreshAccount = (platform) => request("POST", `/api/accounts/${platform}/refresh`);
export const manualToken = (platform, body) => request("POST", `/api/accounts/${platform}/token`, body);
export const tiktokCreator = () => request("GET", "/api/tiktok/creator");

// ------------------------------------------------------------- publish ---
export const listPosts = () => request("GET", "/api/posts");
export const createPosts = (body) => request("POST", "/api/posts", body);
export const cancelPost = (id) => request("DELETE", `/api/posts/${id}`);
export const retryPost = (id) => request("POST", `/api/posts/${id}/retry`);

// --------------------------------------------------------------- stats ---
export const getStats = (refresh = false) => request("GET", `/api/stats${refresh ? "?refresh=1" : ""}`);

// ------------------------------------------------- prefs (browser side) ---
const PREF_KEY = "scannata-clips:prefs";
const DEFAULT_PREFS = {
  quality: "1080",
  fps: 30,
  bitrate: 10,
  watermark: "",
  hashtags: "#clips #fyp #viral #scannata",
  autoPublishTab: true,
};

export function prefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function setPrefs(patch) {
  const next = { ...prefs(), ...patch };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
  } catch {
    /* storage may be blocked; prefs stay for this session only */
  }
  emit("prefs", next);
  return next;
}
