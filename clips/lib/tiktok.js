// TikTok for Developers: Login Kit (OAuth v2), Display API (profile + video
// stats) and the Content Posting API (direct post or send to drafts).
// Docs: https://developers.tiktok.com/doc/content-posting-api-get-started
import fs from "node:fs";

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";

export const SCOPES = [
  "user.info.basic",
  "user.info.profile",
  "user.info.stats",
  "video.list",
  "video.upload",
  "video.publish",
];

export class TikTokError extends Error {
  constructor(message, code, logId) {
    super(message);
    this.code = code;
    this.logId = logId;
  }
}

export function authUrl({ clientKey, redirectUri, state }) {
  const params = new URLSearchParams({
    client_key: clientKey,
    scope: SCOPES.join(","),
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(form) {
  const res = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new TikTokError(body.error_description || body.error || `Token request failed (${res.status})`, body.error, body.log_id);
  }
  return normalizeToken(body);
}

function normalizeToken(body) {
  const now = Date.now();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    openId: body.open_id,
    scope: body.scope,
    expiresAt: now + (body.expires_in || 86400) * 1000,
    refreshExpiresAt: now + (body.refresh_expires_in || 31536000) * 1000,
  };
}

export function exchangeCode({ clientKey, clientSecret, code, redirectUri }) {
  return tokenRequest({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
}

export function refreshToken({ clientKey, clientSecret, refreshToken }) {
  return tokenRequest({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function revoke({ clientKey, clientSecret, accessToken }) {
  await fetch(`${API}/oauth/revoke/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, token: accessToken }),
  }).catch(() => {});
}

async function call(token, pathAndQuery, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json; charset=UTF-8" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  const err = data.error;
  if (!res.ok || (err && err.code && err.code !== "ok")) {
    throw new TikTokError(err?.message || `TikTok API error (${res.status})`, err?.code, err?.log_id);
  }
  return data.data || {};
}

const USER_FIELDS = [
  "open_id",
  "avatar_url",
  "display_name",
  "username",
  "profile_deep_link",
  "follower_count",
  "following_count",
  "likes_count",
  "video_count",
];

export async function getUser(token) {
  const data = await call(token, `/user/info/?fields=${USER_FIELDS.join(",")}`);
  return data.user || {};
}

const VIDEO_FIELDS = [
  "id",
  "title",
  "video_description",
  "create_time",
  "cover_image_url",
  "share_url",
  "duration",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
];

// Pulls up to `limit` most recent videos (20 per page is the API max).
export async function listVideos(token, limit = 60) {
  const videos = [];
  let cursor;
  while (videos.length < limit) {
    const body = { max_count: 20 };
    if (cursor) body.cursor = cursor;
    const data = await call(token, `/video/list/?fields=${VIDEO_FIELDS.join(",")}`, { method: "POST", body });
    videos.push(...(data.videos || []));
    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }
  return videos.slice(0, limit);
}

export function creatorInfo(token) {
  return call(token, "/post/publish/creator_info/query/", { method: "POST", body: {} });
}

// TikTok chunk rules: 5–64 MB per chunk, files under 64 MB go in one chunk,
// and the last chunk absorbs the remainder (it may be up to 128 MB).
export function chunkPlan(size) {
  const MAX_SINGLE = 64 * 1024 * 1024;
  if (size <= MAX_SINGLE) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * 1024 * 1024;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

export async function initPost(token, { mode, size, postInfo }) {
  const { chunkSize, count } = chunkPlan(size);
  const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count };
  if (mode === "draft") {
    return call(token, "/post/publish/inbox/video/init/", { method: "POST", body: { source_info } });
  }
  return call(token, "/post/publish/video/init/", { method: "POST", body: { post_info: postInfo, source_info } });
}

export async function uploadFile(uploadUrl, file, size, mime, onProgress) {
  const { chunkSize, count } = chunkPlan(size);
  const fd = fs.openSync(file, "r");
  try {
    for (let i = 0; i < count; i++) {
      const start = i * chunkSize;
      const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
      const buf = Buffer.alloc(end - start + 1);
      fs.readSync(fd, buf, 0, buf.length, start);
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": mime,
          "Content-Length": String(buf.length),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        },
        body: buf,
      });
      if (!res.ok && res.status !== 206) {
        const text = await res.text().catch(() => "");
        throw new TikTokError(`Upload failed on chunk ${i + 1}/${count} (${res.status}) ${text.slice(0, 200)}`);
      }
      onProgress?.((i + 1) / count);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function fetchStatus(token, publishId) {
  return call(token, "/post/publish/status/fetch/", { method: "POST", body: { publish_id: publishId } });
}
