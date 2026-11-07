# Scannata Clips

A clipping studio that runs on your own computer. Drop in a long video, cut out the best moment, frame it vertical, caption it, export it, then post it to TikTok and Instagram and see how it does.

## Start it

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else to install.

```bash
cd clips
npm start
```

Then open **http://localhost:4747**.

Optional but recommended: install [ffmpeg](https://ffmpeg.org/download.html). When it's there, every export gets converted to a clean H.264 MP4, which is what TikTok and Instagram like best (Firefox records WebM, and Instagram only takes MP4).

- macOS: `brew install ffmpeg`
- Windows: `winget install ffmpeg`
- Linux: `sudo apt install ffmpeg`

## The menu

| Page | What it's for |
| --- | --- |
| **Home** | Drop a video to start. Quick numbers, latest clips, account status. |
| **Studio** | The editor. Cut, trim, reframe to 9:16, captions, colour grade, export. |
| **Library** | Every clip you've exported. Hover to preview. Post, download, re-open, rename, delete. |
| **Publish** | Pick a clip, write a caption, choose TikTok and/or Instagram, post now or schedule. |
| **Data** | Views, engagement, followers, best time and day to post, top clips, every post in a table. |
| **Accounts** | Link TikTok and Instagram (step-by-step setup inside). |
| **Settings** | Export quality, hashtag shortcuts, default watermark, server info. |

## Studio basics

- **Import**: drag videos anywhere in the window, or click the import box. Source files never leave your computer.
- **Cut**: move the playhead and press `S` to split. Select a piece and press `Delete` to drop it. `I` and `O` trim the current piece's start and end to the playhead, which is the fastest way to pull a 30-second moment out of an hour-long podcast.
- **Frame**: 9:16, 4:5, 1:1 or 16:9. "Blur bg" puts a blurred copy behind horizontal footage. Drag the video in the preview to reposition it. Turn on safe zones (the frame icon under the preview) to see where the app buttons sit.
- **Text**: add a hook title, captions or plain text. Drag text in the preview. Paste a transcript to auto-split it into timed captions, then drag the edges on the text track to fine-tune.
- **Look**: colour presets, brightness / contrast / saturation, vignette, fades, a progress bar and a watermark.
- **Audio**: volume, mute, playback speed (pitch is kept).
- **Export** (`Ctrl/Cmd + E`): renders in real time in the browser, so keep the tab visible. The clip is saved to your library.

All shortcuts: click `?` in the Studio top bar.

## Linking TikTok and Instagram

Both platforms only let approved apps post, so you create your own (free) developer app once. The Accounts page walks you through it and shows the exact redirect URL to paste. In short:

1. **Public HTTPS address.** TikTok and Instagram only redirect to `https://` URLs. Run a free tunnel to this studio and paste its address on the Accounts page (or set `PUBLIC_URL` in `.env`):
   ```bash
   npx cloudflared tunnel --url http://localhost:4747
   ```
   Only the login callback and exported videos are reachable through the tunnel. The studio, your library list and the API stay local.
2. **TikTok**: create an app at [developers.tiktok.com](https://developers.tiktok.com/apps), add Login Kit + Content Posting API (with Direct Post on), add the redirect URI, request the scopes listed on the Accounts page, then paste the client key and secret.
   - Until TikTok reviews your app, it works for test users only and posts go up as private ("Only me"). Submit it for review to post publicly. "Send to TikTok drafts" works in the meantime: the video lands in your TikTok inbox and you post it from the app.
3. **Instagram**: your account must be Business or Creator. Create an app at [developers.facebook.com](https://developers.facebook.com/apps), add **Instagram → API setup with Instagram login**, add the redirect URL, add yourself as an Instagram tester, then paste the Instagram app ID and secret.

Keys can also go in `clips/.env` (copy `.env.example`). Tokens are stored in `clips/data/` and refreshed automatically.

## Where things are stored

Everything lives in `clips/data/` (ignored by git):

- `media/`: exported clips and thumbnails
- `clips.json`, `posts.json`: library and post history
- `accounts.json`, `config.json`: tokens and app keys. Keep this folder private.
- `history.json`: one follower snapshot per day, used for the growth chart

## Good to know

- Scheduled posts go out only while `npm start` is running.
- The Data page shows sample numbers until an account is connected, and says so.
- Instagram insights cover your most recent 30 Reels. TikTok covers your latest 60 videos.
- The server only listens on `localhost`. Set `HOST=0.0.0.0` if you want to open it from another device on your network.
- Without the server (e.g. opening the page as a static file) the Studio still edits and exports. Clips then live in the tab until you download them, and posting is off.
