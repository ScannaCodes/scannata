// ACCOUNTS: link TikTok and Instagram.
import { getSettings, saveSettings, disconnect, refreshAccount, manualToken, server, checkHealth, emit } from "../api.js";
import { esc, icon, $, $$, compact, ago, toast, toastError, confirmDialog, copyText, PLATFORMS } from "../ui.js";

let root;
let app;
let settings = null;

const GUIDES = {
  tiktok: {
    portal: "https://developers.tiktok.com/apps",
    steps: (s) => [
      `Go to <a href="https://developers.tiktok.com/apps" target="_blank" rel="noopener">TikTok for Developers</a> and create an app (type: Web).`,
      `Add the products <b>Login Kit</b> and <b>Content Posting API</b>. Turn on <b>Direct Post</b> inside Content Posting.`,
      `Under Login Kit, add this redirect URI: <code>${esc(s.redirectUri)}</code>`,
      `Request the scopes: ${s.scopes.map((x) => `<code>${x}</code>`).join(" ")}`,
      `Copy the <b>Client key</b> and <b>Client secret</b> into the fields below and save. Then hit Connect.`,
    ],
    note: `Until TikTok approves your app, it runs in sandbox: only accounts you add as testers can log in, and posts go up as "Only me". Submit the app for review in the portal to post publicly.`,
    keyLabel: "Client key",
    secretLabel: "Client secret",
  },
  instagram: {
    portal: "https://developers.facebook.com/apps",
    steps: (s) => [
      `Make sure your Instagram is a <b>Business</b> or <b>Creator</b> account (Instagram app → Settings → Account type).`,
      `At <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">Meta for Developers</a>, create an app and add the product <b>Instagram</b> → <b>API setup with Instagram login</b>.`,
      `In <b>Set up Instagram business login</b>, add this redirect URL: <code>${esc(s.redirectUri)}</code>`,
      `Add your Instagram account as an <b>Instagram tester</b> under App roles, and accept the invite in Instagram (Settings → Apps and websites).`,
      `Copy the <b>Instagram app ID</b> and <b>Instagram app secret</b> (not the Facebook ones) into the fields below and save. Then hit Connect.`,
    ],
    note: `The studio asks to read your profile and insights and to publish Reels. In development mode this works for your own tester accounts, which is all you need for your own page.`,
    keyLabel: "Instagram app ID",
    secretLabel: "Instagram app secret",
  },
};

function accountCard(id) {
  const p = PLATFORMS[id];
  const acc = server.health?.accounts?.[id];
  const s = settings[id];
  const prof = acc?.profile || {};
  const status = acc ? (acc.lastError ? ["Needs attention", "warn"] : ["Connected", "ok"]) : s.ready ? ["Ready to connect", "gold"] : ["Setup needed", ""];
  const g = GUIDES[id];
  const keyField = id === "tiktok" ? "clientKey" : "appId";
  const secretField = id === "tiktok" ? "clientSecret" : "appSecret";
  const fromEnv = settings.fromEnv[id];
  const httpsWarn = !settings.publicUrl;

  return `<div class="card acct-card" data-acct="${id}" style="--glow:${id === "tiktok" ? "rgba(57,135,229,.16)" : "rgba(217,89,38,.16)"}">
    <div class="acct-top">
      ${
        prof.avatar
          ? `<img class="avatar lg" src="${esc(prof.avatar)}" alt="" referrerpolicy="no-referrer">`
          : `<div class="acct-logo">${icon(p.icon)}</div>`
      }
      <div style="min-width:0">
        <span class="badge ${status[1]}">${status[0]}</span>
        <h3 style="margin-top:8px">${acc ? esc(prof.name || p.name) : p.name}</h3>
        <div class="muted" style="font-size:13px">${
          acc
            ? `${prof.username ? `@${esc(prof.username)}` : ""}${acc.manual ? " · token added by hand" : ""}${acc.connectedAt ? ` · linked ${ago(acc.connectedAt)}` : ""}`
            : id === "tiktok"
            ? "Post clips and read views, likes, comments and shares."
            : "Post Reels and read views, reach, likes, comments, shares and saves."
        }</div>
      </div>
    </div>
    ${
      acc
        ? `<div class="acct-stats">
        <div><b>${compact(prof.followers)}</b><span>Followers</span></div>
        <div><b>${compact(prof.posts)}</b><span>Posts</span></div>
        <div><b>${compact(id === "tiktok" ? prof.likes : prof.following)}</b><span>${id === "tiktok" ? "Likes" : "Following"}</span></div>
      </div>`
        : ""
    }
    <div class="acct-body">
      ${acc?.lastError ? `<div class="callout warn">${icon("x")}<span>${esc(acc.lastError)}</span></div>` : ""}
      <div class="row wrap">
        ${
          acc
            ? `<button class="btn" data-do="refresh">${icon("refresh")}Refresh</button>
               ${prof.url ? `<a class="btn ghost" href="${esc(prof.url)}" target="_blank" rel="noopener">${icon("external")}Open profile</a>` : ""}
               <span class="spacer"></span>
               <button class="btn ghost danger" data-do="disconnect">Disconnect</button>`
            : `<button class="btn primary" data-do="connect" ${s.ready ? "" : "disabled"}>${icon(p.icon)}Connect ${p.name}</button>
               ${s.ready ? "" : `<span class="help">Add your app keys below first.</span>`}`
        }
      </div>
      ${
        !acc && s.ready && httpsWarn
          ? `<div class="callout warn" style="margin-top:16px;margin-bottom:0">${icon("bolt")}<span>${p.name} only accepts HTTPS redirect URLs. Set a public URL below (a free tunnel works) before connecting.</span></div>`
          : ""
      }
    </div>
    <details class="setup" ${!acc && !s.ready ? "open" : ""}>
      <summary>${icon("settings")}App setup${s.ready ? ` <span class="badge ok">keys saved</span>` : ""}</summary>
      <div class="setup-body">
        <ol class="steps">${g.steps(s).map((x) => `<li><span>${x}</span></li>`).join("")}</ol>
        <div class="callout">${icon("eye")}<span>${g.note}</span></div>
        <label class="field"><span>Redirect URI</span>
          <div class="input-row"><input class="input" readonly value="${esc(s.redirectUri)}"><button class="btn icon" data-copy="${esc(s.redirectUri)}" title="Copy">${icon("copy")}</button></div></label>
        ${
          fromEnv
            ? `<p class="help">Keys are set in <code>clips/.env</code>. Edit that file to change them.</p>`
            : `<div class="two">
          <label class="field"><span>${g.keyLabel}</span><input class="input" data-key="${keyField}" value="${esc(s[keyField] || "")}" autocomplete="off" spellcheck="false"></label>
          <label class="field"><span>${g.secretLabel}</span><input class="input" type="password" data-secret="${secretField}" placeholder="${s.hasSecret ? esc(s.secretHint) : ""}" autocomplete="new-password"></label>
        </div>
        <button class="btn" data-do="saveKeys">${icon("check")}Save keys</button>`
        }
        <details style="margin-top:22px">
          <summary class="label" style="cursor:pointer;list-style:none">+ Paste an access token instead</summary>
          <p class="help" style="margin:10px 0">For testing: paste a token from the developer portal${
            id === "instagram" ? " (App dashboard → Instagram → Generate token)" : ""
          }. It isn't refreshed automatically.</p>
          <label class="field"><span>Access token</span><input class="input" data-token autocomplete="off" spellcheck="false"></label>
          ${id === "instagram" ? `<label class="field"><span>Instagram user ID (optional)</span><input class="input" data-userid></label>` : ""}
          <button class="btn sm" data-do="saveToken">Use this token</button>
        </details>
      </div>
    </details>
  </div>`;
}

function render() {
  if (!server.online) {
    $("#acctBody", root).innerHTML = `<div class="empty"><h3>The local server isn't running</h3>
      <p>Linking accounts needs it. In a terminal, open the <code>clips</code> folder and run <code>npm start</code>.</p></div>`;
    return;
  }
  if (!settings) return;
  $("#acctBody", root).innerHTML = `
    <div class="grid cols-2" style="align-items:start;margin-bottom:28px">${accountCard("tiktok")}${accountCard("instagram")}</div>
    <div class="card">
      <div class="section-head"><h3 class="section-title">Public address</h3>${settings.publicUrl ? `<span class="badge ok">${icon("check")}Set</span>` : `<span class="badge warn">Needed for login</span>`}</div>
      <p class="muted" style="max-width:720px;margin-bottom:18px">TikTok and Instagram send you back to an HTTPS address after you log in. Run a free tunnel that points at this studio and paste its address here. Only the login callback and your exported videos are reachable through it, never the studio itself.</p>
      <div class="grid cols-2">
        <div>
          <div class="label" style="margin-bottom:8px">Option A · Cloudflare (no account needed)</div>
          <p style="margin-bottom:14px"><code>npx cloudflared tunnel --url http://localhost:${location.port || 4747}</code></p>
          <div class="label" style="margin-bottom:8px">Option B · ngrok (stable address with a free account)</div>
          <p><code>ngrok http ${location.port || 4747}</code></p>
          <p class="help" style="margin-top:12px">A quick Cloudflare tunnel gets a new address every time. If it changes, update it here and in both developer portals.</p>
        </div>
        <div>
          ${
            settings.fromEnv.publicUrl
              ? `<p class="help">Set by <code>PUBLIC_URL</code> in <code>clips/.env</code>: <code>${esc(settings.publicUrl)}</code></p>`
              : `<label class="field"><span>Public URL</span><input class="input" id="publicUrl" placeholder="https://your-tunnel.trycloudflare.com" value="${esc(settings.publicUrl)}"></label>
            <button class="btn" id="savePublic">${icon("check")}Save address</button>`
          }
        </div>
      </div>
    </div>`;
}

async function load() {
  if (!server.online) return render();
  try {
    settings = await getSettings();
  } catch (err) {
    toastError(err);
  }
  render();
}

async function onClick(e) {
  const copy = e.target.closest("[data-copy]");
  if (copy) return copyText(copy.dataset.copy);
  if (e.target.closest("#savePublic")) {
    const v = $("#publicUrl", root).value.trim();
    if (v && !/^https:\/\//i.test(v)) return toast("Use an https:// address", { type: "err" });
    try {
      settings = await saveSettings({ publicUrl: v });
      toast("Address saved", { sub: "Copy the new redirect URIs into the developer portals.", type: "ok" });
      render();
    } catch (err) {
      toastError(err);
    }
    return;
  }
  const btn = e.target.closest("[data-do]");
  if (!btn) return;
  const card = btn.closest("[data-acct]");
  const id = card.dataset.acct;
  const name = PLATFORMS[id].name;
  btn.disabled = true;
  try {
    switch (btn.dataset.do) {
      case "connect":
        window.location.href = `/auth/${id}/start`;
        return;
      case "refresh":
        await refreshAccount(id);
        toast(`${name} refreshed`, { type: "ok" });
        break;
      case "disconnect":
        if (!(await confirmDialog(`Disconnect ${name}?`, "Scheduled posts for this account will fail until you connect again.", { ok: "Disconnect", danger: true }))) break;
        await disconnect(id);
        toast(`${name} disconnected`);
        break;
      case "saveKeys": {
        const key = $("[data-key]", card);
        const secret = $("[data-secret]", card);
        const patch = { [id]: { [key.dataset.key]: key.value.trim() } };
        if (secret.value.trim()) patch[id][secret.dataset.secret] = secret.value.trim();
        settings = await saveSettings(patch);
        toast("Keys saved", { sub: settings[id].ready ? "You can connect now." : "Add both the key and the secret.", type: "ok" });
        break;
      }
      case "saveToken": {
        const token = $("[data-token]", card).value.trim();
        if (!token) return toast("Paste a token first", { type: "err" });
        await manualToken(id, { accessToken: token, userId: $("[data-userid]", card)?.value });
        toast(`${name} connected`, { type: "ok" });
        break;
      }
    }
    await checkHealth();
    emit("accounts:changed");
    await load();
  } catch (err) {
    toastError(err, `${name}: something went wrong`);
  } finally {
    btn.disabled = false;
  }
}

export default {
  mount(section, ctx) {
    app = ctx;
    root = section;
    section.innerHTML = `
      <div class="page-head">
        <div><span class="eyebrow">Accounts</span><h1 class="page-title">Link your socials</h1>
        <p class="lede">Connect once, then post straight from the studio and pull your numbers into Data. Keys and tokens stay in <code>clips/data</code> on this computer.</p></div>
      </div>
      <div id="acctBody"></div>`;
    root.addEventListener("click", onClick);
  },
  async show(params = {}) {
    await checkHealth();
    if (params.connected) {
      toast(`${PLATFORMS[params.connected]?.name || "Account"} connected`, { sub: "Your stats will show up in Data.", type: "ok" });
      emit("accounts:changed");
      history.replaceState(null, "", "#/accounts");
    }
    if (params.error) {
      toast(`Couldn't connect ${PLATFORMS[params.platform]?.name || ""}`, { sub: params.error, type: "err", timeout: 9000 });
      history.replaceState(null, "", "#/accounts");
    }
    await load();
  },
};
