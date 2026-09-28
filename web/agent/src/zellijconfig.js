import fs from 'node:fs';
import { config } from './config.js';
import { run } from './exec.js';
import { RpcError } from './errors.js';
import { log } from './log.js';
import { backupPath } from './zellijweb.js';

const TOP_LEVEL_WEB_SHARING = /^[ \t]*web_sharing[ \t]+"([^"]*)"/m;

export function readWebSharing() {
  let text;
  try {
    text = fs.readFileSync(config.zellijConfig, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const m = text.match(TOP_LEVEL_WEB_SHARING);
  return m ? m[1] : null;
}

export async function verifyConfig() {
  const res = await run(config.zellijBin, ['setup', '--check'], { timeout: 15000 });
  const text = `${res.stdout}${res.stderr}`;
  const wellDefined = /\[CONFIG FILE\]:\s*Well defined\./.test(text);
  return { ok: res.code === 0 && wellDefined, text };
}

export async function ensureWebSharing() {
  const current = readWebSharing();
  if (current === 'on') return { changed: false, value: 'on' };

  const original = fs.existsSync(config.zellijConfig) ? fs.readFileSync(config.zellijConfig, 'utf8') : '';
  let backup = null;
  if (original.length > 0) {
    backup = backupPath(config.zellijConfig);
    fs.writeFileSync(backup, original);
    log.info('backed up zellij config', { backup });
  }

  let next;
  if (current === null) {
    const sep = original.endsWith('\n') || original.length === 0 ? '' : '\n';
    next = `${original}${sep}\n// added by mcw-agent: browser clients may attach to sessions created from here\nweb_sharing "on"\n`;
  } else {
    next = original.replace(TOP_LEVEL_WEB_SHARING, 'web_sharing "on"');
  }
  fs.writeFileSync(config.zellijConfig, next);

  const check = await verifyConfig();
  if (!check.ok) {
    if (backup) fs.writeFileSync(config.zellijConfig, original);
    throw new RpcError('internal', 'zellij setup --check rejected the config after adding web_sharing, reverted', {
      output: check.text.slice(0, 4000),
      backup,
    });
  }
  log.info('zellij web_sharing set to on', { previous: current, backup });
  return { changed: true, value: 'on', previous: current, backup };
}
