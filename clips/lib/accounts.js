// Connected accounts: settings resolution, token storage and refresh.
import * as tiktok from "./tiktok.js";
import * as instagram from "./instagram.js";

export class Accounts {
  constructor(store, { port }) {
    this.store = store;
    this.port = port;
  }

  // Settings saved from the UI, with environment variables taking priority.
  settings() {
    const saved = this.store.read("config", {});
    const env = process.env;
    const publicUrl = (env.PUBLIC_URL || saved.publicUrl || "").replace(/\/+$/, "");
    return {
      publicUrl,
      baseUrl: publicUrl || `http://localhost:${this.port}`,
      tiktok: {
        clientKey: env.TIKTOK_CLIENT_KEY || saved.tiktok?.clientKey || "",
        clientSecret: env.TIKTOK_CLIENT_SECRET || saved.tiktok?.clientSecret || "",
      },
      instagram: {
        appId: env.INSTAGRAM_APP_ID || saved.instagram?.appId || "",
        appSecret: env.INSTAGRAM_APP_SECRET || saved.instagram?.appSecret || "",
        apiVersion: env.INSTAGRAM_API_VERSION || saved.instagram?.apiVersion || "v23.0",
      },
      fromEnv: {
        publicUrl: !!env.PUBLIC_URL,
        tiktok: !!(env.TIKTOK_CLIENT_KEY || env.TIKTOK_CLIENT_SECRET),
        instagram: !!(env.INSTAGRAM_APP_ID || env.INSTAGRAM_APP_SECRET),
      },
    };
  }

  redirectUri(platform) {
    return `${this.settings().baseUrl}/auth/${platform}/callback`;
  }

  // Safe view for the browser: never send secrets back.
  publicSettings() {
    const s = this.settings();
    const mask = (v) => (v ? `${v.slice(0, 4)}••••${v.slice(-2)}` : "");
    return {
      publicUrl: s.publicUrl,
      baseUrl: s.baseUrl,
      fromEnv: s.fromEnv,
      tiktok: {
        clientKey: s.tiktok.clientKey,
        hasSecret: !!s.tiktok.clientSecret,
        secretHint: mask(s.tiktok.clientSecret),
        redirectUri: this.redirectUri("tiktok"),
        scopes: tiktok.SCOPES,
        ready: !!(s.tiktok.clientKey && s.tiktok.clientSecret),
      },
      instagram: {
        appId: s.instagram.appId,
        hasSecret: !!s.instagram.appSecret,
        secretHint: mask(s.instagram.appSecret),
        apiVersion: s.instagram.apiVersion,
        redirectUri: this.redirectUri("instagram"),
        scopes: instagram.SCOPES,
        ready: !!(s.instagram.appId && s.instagram.appSecret),
      },
    };
  }

  saveSettings(patch) {
    this.store.update("config", {}, (cfg) => {
      if (typeof patch.publicUrl === "string") cfg.publicUrl = patch.publicUrl.trim();
      if (patch.tiktok) {
        cfg.tiktok = cfg.tiktok || {};
        if (typeof patch.tiktok.clientKey === "string") cfg.tiktok.clientKey = patch.tiktok.clientKey.trim();
        if (patch.tiktok.clientSecret) cfg.tiktok.clientSecret = patch.tiktok.clientSecret.trim();
      }
      if (patch.instagram) {
        cfg.instagram = cfg.instagram || {};
        if (typeof patch.instagram.appId === "string") cfg.instagram.appId = patch.instagram.appId.trim();
        if (patch.instagram.appSecret) cfg.instagram.appSecret = patch.instagram.appSecret.trim();
        if (patch.instagram.apiVersion) cfg.instagram.apiVersion = patch.instagram.apiVersion.trim();
      }
      return cfg;
    });
  }

  all() {
    return this.store.read("accounts", {});
  }

  get(platform) {
    return this.all()[platform] || null;
  }

  set(platform, value) {
    this.store.update("accounts", {}, (acc) => {
      if (value) acc[platform] = value;
      else delete acc[platform];
      return acc;
    });
  }

  // Summary for the UI (no tokens).
  summary() {
    const out = {};
    for (const [platform, a] of Object.entries(this.all())) {
      out[platform] = {
        connected: true,
        manual: !!a.manual,
        profile: a.profile || {},
        connectedAt: a.connectedAt,
        expiresAt: a.expiresAt,
        lastError: a.lastError || null,
      };
    }
    return out;
  }

  // Returns a usable access token, refreshing it when needed.
  async token(platform) {
    const acc = this.get(platform);
    if (!acc) throw new Error(`${platform === "tiktok" ? "TikTok" : "Instagram"} is not connected`);
    const s = this.settings();

    if (platform === "tiktok") {
      if (acc.expiresAt && Date.now() > acc.expiresAt - 5 * 60 * 1000 && acc.refreshToken && s.tiktok.clientSecret) {
        const next = await tiktok.refreshToken({
          clientKey: s.tiktok.clientKey,
          clientSecret: s.tiktok.clientSecret,
          refreshToken: acc.refreshToken,
        });
        this.set("tiktok", { ...acc, ...next });
        return next.accessToken;
      }
      return acc.accessToken;
    }

    // Instagram long-lived tokens can be refreshed once they are 24h old.
    const dayOld = Date.now() - (acc.refreshedAt || 0) > 24 * 3600 * 1000;
    const nearExpiry = acc.expiresAt && Date.now() > acc.expiresAt - 10 * 24 * 3600 * 1000;
    if (dayOld && nearExpiry) {
      try {
        const next = await instagram.refreshToken(acc.accessToken);
        this.set("instagram", { ...acc, ...next });
        return next.accessToken;
      } catch (err) {
        console.warn("[instagram] token refresh failed:", err.message);
      }
    }
    return acc.accessToken;
  }

  async loadProfile(platform) {
    const token = await this.token(platform);
    if (platform === "tiktok") {
      const u = await tiktok.getUser(token);
      return {
        id: u.open_id,
        username: u.username || "",
        name: u.display_name || u.username || "TikTok",
        avatar: u.avatar_url || "",
        url: u.profile_deep_link || (u.username ? `https://www.tiktok.com/@${u.username}` : ""),
        followers: u.follower_count ?? null,
        following: u.following_count ?? null,
        likes: u.likes_count ?? null,
        posts: u.video_count ?? null,
      };
    }
    const version = this.settings().instagram.apiVersion;
    const p = await instagram.getProfile(version, token);
    return {
      id: String(p.user_id || p.id || ""),
      username: p.username || "",
      name: p.name || p.username || "Instagram",
      avatar: p.profile_picture_url || "",
      url: p.username ? `https://www.instagram.com/${p.username}/` : "",
      followers: p.followers_count ?? null,
      following: p.follows_count ?? null,
      posts: p.media_count ?? null,
    };
  }

  async connect(platform, tokenData, { manual = false } = {}) {
    this.set(platform, { ...tokenData, manual, connectedAt: Date.now() });
    try {
      const profile = await this.loadProfile(platform);
      const acc = this.get(platform);
      this.set(platform, { ...acc, profile, userId: acc.userId || profile.id, lastError: null });
      return profile;
    } catch (err) {
      if (manual) {
        this.set(platform, null);
        throw err;
      }
      const acc = this.get(platform);
      this.set(platform, { ...acc, lastError: err.message });
      return null;
    }
  }

  async disconnect(platform) {
    const acc = this.get(platform);
    if (acc && platform === "tiktok") {
      const s = this.settings();
      if (s.tiktok.clientSecret) {
        await tiktok.revoke({ clientKey: s.tiktok.clientKey, clientSecret: s.tiktok.clientSecret, accessToken: acc.accessToken });
      }
    }
    this.set(platform, null);
  }
}
