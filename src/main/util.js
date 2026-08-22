// Small filesystem and formatting helpers shared by the main-process modules.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

export async function exists(p) {
  return (await statOrNull(p)) !== null;
}

export async function readDirSafe(p, opts) {
  try {
    return await fs.readdir(p, opts);
  } catch {
    return [];
  }
}

export async function readJsonSafe(p, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically: temp file in the same directory, then rename over. */
export async function writeJsonAtomic(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

/** Recursive size + file count of a path. Returns zeros for anything missing. */
export async function measure(target) {
  const st = await statOrNull(target);
  if (!st) return { bytes: 0, files: 0, exists: false };
  if (st.isFile()) return { bytes: st.size, files: 1, exists: true };
  if (!st.isDirectory()) return { bytes: 0, files: 0, exists: true };

  let bytes = 0;
  let files = 0;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of await readDirSafe(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else {
        const s = await statOrNull(full);
        if (s) {
          bytes += s.size;
          files += 1;
        }
      }
    }
  }
  return { bytes, files, exists: true };
}

/**
 * Stream a .jsonl file line by line, invoking `onRecord` for each parsed object.
 * Malformed lines are counted rather than thrown -- a truncated final line is
 * normal for a session that is still being written.
 */
export async function readJsonl(file, onRecord) {
  let bad = 0;
  let total = 0;
  const stream = fsSync.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      total += 1;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        bad += 1;
        continue;
      }
      const stop = onRecord(obj, total);
      if (stop === false) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { total, bad };
}

/** Move a path, falling back to copy+remove when rename crosses a volume. */
export async function movePath(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  await fs.cp(from, to, { recursive: true });
  await fs.rm(from, { recursive: true, force: true });
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
