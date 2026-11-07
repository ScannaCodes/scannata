// HTTP helpers: JSON responses, body reading, and static/media file serving
// with Range support (the <video> element needs ranges to seek).
import fs from "node:fs";
import path from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

export function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

// Stream a request body straight to disk (used for video uploads, which can be large).
export function pipeToFile(req, file, limit) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit && !failed) {
        failed = true;
        out.destroy();
        fs.rm(file, { force: true }, () => {});
        reject(new HttpError(413, `File is larger than ${Math.round(limit / 1048576)} MB`));
        req.destroy();
      }
    });
    req.pipe(out);
    out.on("finish", () => !failed && resolve(size));
    out.on("error", (err) => !failed && reject(err));
    req.on("error", (err) => !failed && reject(err));
  });
}

export function serveFile(req, res, file, { cache = "no-cache" } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    return false;
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
    "Last-Modified": stat.mtime.toUTCString(),
  };
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : NaN;
    let end = match && match[2] ? parseInt(match[2], 10) : NaN;
    if (Number.isNaN(start)) {
      // suffix range: last N bytes
      start = Math.max(0, stat.size - (Number.isNaN(end) ? 0 : end));
      end = stat.size - 1;
    }
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return true;
    }
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
    });
    if (req.method === "HEAD") return res.end(), true;
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  if (req.method === "HEAD") return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}
