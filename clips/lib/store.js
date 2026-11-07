// Tiny JSON-file store. Every collection lives in data/<name>.json and is
// written atomically (write to tmp, then rename) so a crash never leaves a
// half-written file behind.
import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.mediaDir = path.join(dir, "media");
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.cache = new Map();
  }

  file(name) {
    return path.join(this.dir, `${name}.json`);
  }

  read(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(this.file(name), "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`[store] could not read ${name}.json:`, err.message);
    }
    this.cache.set(name, value);
    return value;
  }

  write(name, value) {
    this.cache.set(name, value);
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
    return value;
  }

  update(name, fallback, fn) {
    const current = structuredClone(this.read(name, fallback));
    const next = fn(current) ?? current;
    return this.write(name, next);
  }
}

export const uid = (prefix = "") =>
  prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
