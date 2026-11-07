// Scannata Clips: local server.
// Serves the studio UI, stores your clips, talks to TikTok and Instagram.
// Run with:  npm start   (then open http://localhost:4747)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadEnv } from "./lib/env.js";
import { Store, uid } from "./lib/store.js";
import { json, redirect, readBody, readJson, pipeToFile, serveFile, HttpError } from "./lib/http.js";
import { Accounts } from "./lib/accounts.js";
import { Clips } from "./lib/clips.js";
import { Publisher } from "./lib/publisher.js";
import { Stats } from "./lib/stats.js";
import { detectFfmpeg } from "./lib/media.js";
import * as tiktok from "./lib/tiktok.js";
import * as instagram from "./lib/instagram.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.CLIPS_DATA || path.join(ROOT, "data"));
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 1024) * 1024 * 1024;
const VERSION = "1.0.0";

const store = new Store(DATA_DIR);
const accounts = new Accounts(store, { port: PORT });
const clips = new Clips(store);
const publisher = new Publisher(store, accounts, clips);
const stats = new Stats(store, accounts);

// OAuth state values, valid for 10 minutes.
const oauthStates = new Map();
function newState(platform) {
  const state = crypto.randomBytes(18).toString("base64url");
  oauthStates.set(state, { platform, at: Date.now() });
  for (const [k, v] of oauthStates) if (Date.now() - v.at > 600000) oauthStates.delete(k);
  return state;
}

// Only answer requests addressed to this machine (blocks DNS-rebinding).
// Requests arriving through PUBLIC_URL (your tunnel) may only reach the OAuth
// callbacks and media files, never the API or the studio itself.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function hostAccess(req, pathname) {
  const host = (req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  if (LOCAL_HOSTS.has(host)) return true;
  const pub = accounts.settings().publicUrl;
  let pubHost = "";
  try {
    pubHost = pub ? new URL(pub).hostname.toLowerCase() : "";
  } catch {
    /* ignore bad url */
  }
  if (pubHost && host === pubHost) {
    return /^\/auth\/(tiktok|instagram)\/callback\/?$/.test(pathname) || pathname.startsWith("/media/");
  }
  return HOST !== "127.0.0.1" && HOST !== "localhost"; // user opted into LAN access with HOST=0.0.0.0
}

const clipView = (c) => ({
  ...c,
  url: `/media/${encodeURIComponent(c.file)}`,
  thumbUrl: c.thumb ? `/media/${encodeURIComponent(c.thumb)}?v=${c.createdAt}` : null,
});

function finishOAuthPage(res, platform, error) {
  const target = `http://localhost:${PORT}/#/accounts?${error ? `error=${encodeURIComponent(error)}&platform=${platform}` : `connected=${platform}`}`;
  redirect(res, target);
}

// ---------------------------------------------------------------- routes ----
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(
    "^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$"
  );
  routes.push({ method, re, keys, handler });
};

route("GET", "/api/health", async () => ({
  ok: true,
  version: VERSION,
  ffmpeg: !!(await detectFfmpeg()),
  dataDir: DATA_DIR,
  accounts: accounts.summary(),
  publishing: publisher.hasActive(),
}));

// ---- settings
route("GET", "/api/settings", () => accounts.publicSettings());
route("POST", "/api/settings", async (req) => {
  accounts.saveSettings(await readJson(req));
  return accounts.publicSettings();
});

// ---- accounts
route("GET", "/api/accounts", () => accounts.summary());

route("DELETE", "/api/accounts/:platform", async (req, res, { platform }) => {
  await accounts.disconnect(platform);
  stats.invalidate();
  return accounts.summary();
});

route("POST", "/api/accounts/:platform/refresh", async (req, res, { platform }) => {
  const profile = await accounts.loadProfile(platform);
  accounts.set(platform, { ...accounts.get(platform), profile, lastError: null });
  stats.invalidate();
  return accounts.summary();
});

// Paste a token by hand (handy for testing with tokens from the developer portals).
route("POST", "/api/accounts/:platform/token", async (req, res, { platform }) => {
  const { accessToken, refreshToken, userId } = await readJson(req);
  if (!accessToken) throw new HttpError(400, "Paste an access token first");
  if (!["tiktok", "instagram"].includes(platform)) throw new HttpError(404, "Unknown platform");
  await accounts.connect(
    platform,
    platform === "tiktok"
      ? { accessToken: accessToken.trim(), refreshToken: refreshToken?.trim() || null, expiresAt: null }
      : { accessToken: accessToken.trim(), userId: userId?.trim() || null, expiresAt: Date.now() + 50 * 86400000, refreshedAt: Date.now() },
    { manual: true }
  );
  stats.invalidate();
  return accounts.summary();
});

route("GET", "/api/tiktok/creator", async () => {
  const token = await accounts.token("tiktok");
  return tiktok.creatorInfo(token);
});

// ---- OAuth
route("GET", "/auth/tiktok/start", (req, res) => {
  const s = accounts.settings();
  if (!s.tiktok.clientKey || !s.tiktok.clientSecret) {
    return finishOAuthPage(res, "tiktok", "Add your TikTok client key and secret first");
  }
  redirect(res, tiktok.authUrl({ clientKey: s.tiktok.clientKey, redirectUri: accounts.redirectUri("tiktok"), state: newState("tiktok") }));
});

route("GET", "/auth/tiktok/callback", async (req, res, params, url) => {
  const q = url.searchParams;
  const state = oauthStates.get(q.get("state"));
  oauthStates.delete(q.get("state"));
  if (q.get("error")) return finishOAuthPage(res, "tiktok", q.get("error_description") || q.get("error"));
  if (!state || state.platform !== "tiktok") return finishOAuthPage(res, "tiktok", "Login expired, please try again");
  try {
    const s = accounts.settings();
    const token = await tiktok.exchangeCode({
      clientKey: s.tiktok.clientKey,
      clientSecret: s.tiktok.clientSecret,
      code: q.get("code"),
      redirectUri: accounts.redirectUri("tiktok"),
    });
    await accounts.connect("tiktok", token);
    stats.invalidate();
    finishOAuthPage(res, "tiktok");
  } catch (err) {
    finishOAuthPage(res, "tiktok", err.message);
  }
});

route("GET", "/auth/instagram/start", (req, res) => {
  const s = accounts.settings();
  if (!s.instagram.appId || !s.instagram.appSecret) {
    return finishOAuthPage(res, "instagram", "Add your Instagram app ID and secret first");
  }
  redirect(res, instagram.authUrl({ appId: s.instagram.appId, redirectUri: accounts.redirectUri("instagram"), state: newState("instagram") }));
});

route("GET", "/auth/instagram/callback", async (req, res, params, url) => {
  const q = url.searchParams;
  const state = oauthStates.get(q.get("state"));
  oauthStates.delete(q.get("state"));
  if (q.get("error")) return finishOAuthPage(res, "instagram", q.get("error_description") || q.get("error_reason") || q.get("error"));
  if (!state || state.platform !== "instagram") return finishOAuthPage(res, "instagram", "Login expired, please try again");
  try {
    const s = accounts.settings();
    const token = await instagram.exchangeCode({
      appId: s.instagram.appId,
      appSecret: s.instagram.appSecret,
      code: q.get("code"),
      redirectUri: accounts.redirectUri("instagram"),
    });
    await accounts.connect("instagram", token);
    stats.invalidate();
    finishOAuthPage(res, "instagram");
  } catch (err) {
    finishOAuthPage(res, "instagram", err.message);
  }
});

// ---- clips
route("GET", "/api/clips", () => clips.list().map(clipView));

route("POST", "/api/clips", async (req, res, params, url) => {
  const q = url.searchParams;
  const tmp = path.join(store.mediaDir, `${uid("up_")}.part`);
  try {
    const size = await pipeToFile(req, tmp, MAX_UPLOAD);
    if (!size) throw new HttpError(400, "The upload was empty");
    const clip = await clips.add({
      tmpFile: tmp,
      size,
      name: q.get("name"),
      mime: req.headers["content-type"],
      duration: q.get("duration"),
      width: q.get("width"),
      height: q.get("height"),
      source: q.get("source"),
    });
    return clipView(clip);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
});

route("POST", "/api/clips/:id/thumb", async (req, res, { id }) => {
  const buf = await readBody(req, 5 * 1024 * 1024);
  const clip = clips.saveThumb(id, buf);
  if (!clip) throw new HttpError(404, "Clip not found");
  return clipView(clip);
});

route("PATCH", "/api/clips/:id", async (req, res, { id }) => {
  const { name } = await readJson(req);
  const clip = clips.rename(id, name);
  if (!clip) throw new HttpError(404, "Clip not found");
  return clipView(clip);
});

route("DELETE", "/api/clips/:id", (req, res, { id }) => {
  if (!clips.remove(id)) throw new HttpError(404, "Clip not found");
  return { ok: true };
});

// ---- publishing
route("GET", "/api/posts", () => publisher.list());
route("POST", "/api/posts", async (req) => publisher.create(await readJson(req)));
route("DELETE", "/api/posts/:id", (req, res, { id }) => (publisher.cancel(id), { ok: true }));
route("POST", "/api/posts/:id/retry", (req, res, { id }) => (publisher.retry(id), { ok: true }));

// ---- stats
route("GET", "/api/stats", async (req, res, params, url) => stats.get({ force: url.searchParams.get("refresh") === "1" }));

// ------------------------------------------------------------ dispatcher ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (!hostAccess(req, pathname)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Host not allowed");
  }

  // Mutating API calls must carry our custom header. Browsers will not send a
  // custom header cross-origin without a CORS preflight (which we never
  // approve), so other websites cannot drive this server.
  if (pathname.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD" && req.headers["x-clips"] !== "1") {
    return json(res, 403, { error: "Missing X-Clips header" });
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    try {
      const result = await r.handler(req, res, params, url);
      if (!res.headersSent && result !== undefined) json(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[${req.method} ${pathname}]`, err.message);
      if (!res.headersSent) json(res, status, { error: err.message || "Something went wrong" });
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 404, { error: "Not found" });

  if (pathname.startsWith("/media/")) {
    const name = path.basename(pathname);
    if (serveFile(req, res, path.join(store.mediaDir, name), { cache: "private, max-age=3600" })) return;
    return json(res, 404, { error: "Not found" });
  }
  if (pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });

  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" });
  if (serveFile(req, res, file)) return;
  serveFile(req, res, path.join(PUBLIC_DIR, "index.html"));
});

server.requestTimeout = 0; // big uploads take a while
server.listen(PORT, HOST, async () => {
  const ff = await detectFfmpeg();
  const line = "─".repeat(46);
  console.log(`\n  ${line}`);
  console.log(`   SCANNATA CLIPS  ·  v${VERSION}`);
  console.log(`  ${line}`);
  console.log(`   Studio     http://localhost:${PORT}`);
  console.log(`   Data dir   ${DATA_DIR}`);
  console.log(`   ffmpeg     ${ff ? "found, exports are converted to clean MP4" : "not found (optional, see README)"}`);
  const pub = accounts.settings().publicUrl;
  if (pub) console.log(`   Public URL ${pub}`);
  console.log(`  ${line}\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use. Start with another port:  PORT=4848 npm start\n`);
    process.exit(1);
  }
  throw err;
});
