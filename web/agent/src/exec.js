import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from './config.js';
import { RpcError } from './errors.js';

function childEnv(extra) {
  return {
    ...process.env,
    HOME: process.env.HOME || os.homedir(),
    XDG_RUNTIME_DIR: config.runtimeDir,
    PATH: `${process.env.HOME || os.homedir()}/.local/bin:${process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`,
    ...(extra || {}),
  };
}

export function run(cmd, args, opts = {}) {
  const timeout = opts.timeout || 30000;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: childEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: opts.detached === true,
    });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ code: null, stdout: out, stderr: err + `\n[mcw-agent] timed out after ${timeout}ms`, timedOut: true });
    }, timeout);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: out, stderr: String(e.message), spawnError: true });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut: false });
    });
    if (opts.detached) child.unref();
  });
}

export async function runOrThrow(cmd, args, opts = {}) {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    throw new RpcError(res.timedOut ? 'timeout' : 'internal', `${cmd} ${args.join(' ')} failed`, {
      exitCode: res.code,
      stdout: res.stdout.slice(-4000),
      stderr: res.stderr.slice(-4000),
    });
  }
  return res;
}

const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(s) {
  return s.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
}
