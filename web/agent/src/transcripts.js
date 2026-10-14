import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { RpcError } from './errors.js';

const HEAD_BYTES = 262144;
const SKIP = /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr|system-reminder)/;

function textOf(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
  }
  return '';
}

async function titleOf(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    if (bytesRead === HEAD_BYTES) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary.trim()) {
        return obj.summary.trim();
      }
      if (obj.type === 'user' && !obj.isMeta) {
        const t = textOf(obj.message).trim();
        if (!t || SKIP.test(t) || t.startsWith('Caveat:')) continue;
        return t.replace(/\s+/g, ' ').slice(0, 200);
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function listTranscripts(params = {}) {
  let limit = params.limit === undefined || params.limit === null ? 100 : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RpcError('bad_request', 'limit must be an integer 1 to 500', { limit: params.limit });
  }

  let names;
  try {
    names = fs.readdirSync(config.transcriptDir);
  } catch (e) {
    throw new RpcError('not_found', 'transcript directory is unreadable', {
      dir: config.transcriptDir,
      error: String(e.message),
    });
  }

  const entries = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const full = path.join(config.transcriptDir, n);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    entries.push({ uuid: n.slice(0, -6), file: full, mtime: Math.floor(st.mtimeMs / 1000), size: st.size });
  }
  entries.sort((a, b) => b.mtime - a.mtime);

  const picked = entries.slice(0, limit);
  const transcripts = [];
  for (const e of picked) {
    transcripts.push({
      uuid: e.uuid,
      title: (await titleOf(e.file)) || e.uuid,
      mtime: e.mtime,
      size: e.size,
    });
  }
  return { transcripts, total: entries.length };
}
