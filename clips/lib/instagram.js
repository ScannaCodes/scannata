// Instagram API with Instagram Login (Business / Creator accounts).
// Covers OAuth, long-lived tokens, profile + media insights, and Reels
// publishing through resumable upload (no public URL needed).
// Docs: https://developers.facebook.com/docs/instagram-platform
import fs from "node:fs";

export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
];

export class InstagramError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const graph = (version) => `https://graph.instagram.com/${version}`;

export function authUrl({ appId, redirectUri, state }) {
  const params = new URLSearchParams({
    enable_fb_login: "0",
    force_authentication: "1",
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(","),
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

async function parse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || body.error_message) {
    const e = body.error || {};
    throw new InstagramError(
      e.error_user_msg || e.message || body.error_message || `Instagram API error (${res.status})`,
      e.code || body.code
    );
  }
  return body;
}

export async function exchangeCode({ appId, appSecret, code, redirectUri }) {
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code: code.replace(/#_$/, ""),
    }),
  });
  const body = await parse(res);
  const short = Array.isArray(body.data) ? body.data[0] : body;
  // Swap the 1-hour token for a 60-day one straight away.
  const long = await parse(
    await fetch(
      `https://graph.instagram.com/access_token?${new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: appSecret,
        access_token: short.access_token,
      })}`
    )
  );
  return {
    accessToken: long.access_token,
    userId: String(short.user_id || ""),
    expiresAt: Date.now() + (long.expires_in || 5184000) * 1000,
    refreshedAt: Date.now(),
  };
}

export async function refreshToken(accessToken) {
  const body = await parse(
    await fetch(
      `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({
        grant_type: "ig_refresh_token",
        access_token: accessToken,
      })}`
    )
  );
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 5184000) * 1000,
    refreshedAt: Date.now(),
  };
}

async function get(version, token, pathname, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  return parse(await fetch(`${graph(version)}${pathname}?${qs}`));
}

async function post(version, token, pathname, params = {}) {
  return parse(
    await fetch(`${graph(version)}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, access_token: token }),
    })
  );
}

export function getProfile(version, token) {
  return get(version, token, "/me", {
    fields: "user_id,username,name,profile_picture_url,followers_count,follows_count,media_count",
  });
}

export async function listMedia(version, token, limit = 50) {
  const body = await get(version, token, "/me/media", {
    fields:
      "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count",
    limit: String(Math.min(limit, 100)),
  });
  return body.data || [];
}

// Insight metric names shift between API versions; ask for the set we want and
// fall back to a smaller set if the API rejects one of them.
export async function mediaInsights(version, token, mediaId) {
  const attempts = ["views,reach,saved,shares,likes,comments", "reach,saved,shares", "reach"];
  for (const metric of attempts) {
    try {
      const body = await get(version, token, `/${mediaId}/insights`, { metric });
      const out = {};
      for (const m of body.data || []) out[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
      return out;
    } catch {
      /* try the next, smaller set */
    }
  }
  return {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function publishReel(version, token, userId, { file, size, caption, shareToFeed, publicVideoUrl, onStage }) {
  const base = { media_type: "REELS", caption: caption || "", share_to_feed: shareToFeed ? "true" : "false" };
  let container;

  try {
    onStage?.("Creating upload session");
    container = await post(version, token, `/${userId}/media`, { ...base, upload_type: "resumable" });
    const uri = container.uri || `https://rupload.facebook.com/ig-api-upload/${version}/${container.id}`;
    onStage?.("Uploading video to Instagram");
    const res = await fetch(uri, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${token}`,
        offset: "0",
        file_size: String(size),
        "Content-Type": "application/octet-stream",
      },
      body: fs.readFileSync(file),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new InstagramError(body.debug_info?.message || body.error?.message || `Upload failed (${res.status})`);
    }
  } catch (err) {
    if (!publicVideoUrl) throw err;
    // Fallback: let Instagram fetch the file from our public URL.
    onStage?.("Resumable upload failed, using public video URL");
    container = await post(version, token, `/${userId}/media`, { ...base, video_url: publicVideoUrl });
  }

  onStage?.("Instagram is processing the video");
  const started = Date.now();
  for (;;) {
    const status = await get(version, token, `/${container.id}`, { fields: "status_code,status" });
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new InstagramError(`Instagram could not process the video: ${status.status || status.status_code}`);
    }
    if (Date.now() - started > 10 * 60 * 1000) throw new InstagramError("Timed out waiting for Instagram to process the video");
    await sleep(5000);
  }

  onStage?.("Publishing");
  const published = await post(version, token, `/${userId}/media_publish`, { creation_id: container.id });
  let permalink = "";
  try {
    permalink = (await get(version, token, `/${published.id}`, { fields: "permalink" })).permalink;
  } catch {
    /* permalink is a nice-to-have */
  }
  return { mediaId: published.id, permalink };
}
