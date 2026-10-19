import fs from 'node:fs';

// Read up to `bytes` from the start of a file and return complete lines.
export function readHeadLines(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const lines = text.split('\n');
    if (n === bytes) lines.pop(); // last line is probably cut off
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Read up to `bytes` from the end of a file and return complete lines.
export function readTailLines(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is probably cut off
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function parseJsonLines(lines) {
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch { /* skip partial or bad lines */ }
  }
  return out;
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function clip(s, n = 400) {
  if (s == null) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + ` … (+${s.length - n} chars)` : s;
}

export function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}
