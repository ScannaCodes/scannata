// Optional ffmpeg integration. Browsers record clips as fragmented MP4 or WebM;
// when ffmpeg is installed we re-encode to a clean H.264/AAC MP4 with the moov
// atom up front, which is what TikTok and Instagram Reels like best.
import { spawn } from "node:child_process";

let ffmpegPath = null;
let probed = false;

export async function detectFfmpeg() {
  if (probed) return ffmpegPath;
  probed = true;
  const candidate = process.env.FFMPEG_PATH || "ffmpeg";
  ffmpegPath = await new Promise((resolve) => {
    const p = spawn(candidate, ["-version"], { stdio: "ignore" });
    p.on("error", () => resolve(null));
    p.on("exit", (code) => resolve(code === 0 ? candidate : null));
  });
  return ffmpegPath;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
    });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.split("\n").slice(-4).join(" ")}`))));
  });
}

export async function normalizeToMp4(input, output) {
  if (!(await detectFfmpeg())) throw new Error("ffmpeg is not installed");
  await run([
    "-y",
    "-hide_banner",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "19",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "48000",
    "-movflags", "+faststart",
    output,
  ]);
}

export async function makeThumbnail(input, output, atSeconds = 0.5) {
  if (!(await detectFfmpeg())) return false;
  try {
    await run(["-y", "-hide_banner", "-ss", String(atSeconds), "-i", input, "-frames:v", "1", "-vf", "scale=360:-2", output]);
    return true;
  } catch {
    return false;
  }
}
