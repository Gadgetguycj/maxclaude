import os from 'node:os';
import { config, webOrigin } from './config.js';
import { run } from './exec.js';
import { RpcError } from './errors.js';
import { listSessions, createSession, deleteSession, renameSession, hibernateSession, hibernateCandidates, wakeSession, reserveSessionViewer, releaseSessionViewer } from './sessions.js';
import { listTranscripts } from './transcripts.js';
import { webStatus, tokenName } from './zellijweb.js';
import { readWebSharing } from './zellijconfig.js';
import { statPaths } from './files.js';

const startedAt = Math.floor(Date.now() / 1000);

export async function agentInfo() {
  const version = await run(config.zellijBin, ['--version'], { timeout: 10000 });
  const status = await webStatus();
  return {
    host: os.hostname(),
    agentVersion: config.version,
    zellijVersion: `${version.stdout}`.trim() || null,
    webServer: { running: status.online, url: webOrigin, status: status.text },
    webSharing: readWebSharing(),
    tokenName: tokenName(),
    startedAt,
  };
}

const table = {
  'agent.info': () => agentInfo(),
  'sessions.list': () => listSessions(),
  'sessions.create': (params) => createSession(params || {}),
  'sessions.rename': (params) => renameSession(params || {}),
  'sessions.delete': (params) => deleteSession(params || {}),
  'sessions.hibernateCandidates': (params) => hibernateCandidates(params || {}),
  'sessions.hibernate': (params) => hibernateSession(params || {}),
  'sessions.wake': (params) => wakeSession(params || {}),
  'sessions.reserveViewer': (params) => reserveSessionViewer(params || {}),
  'sessions.releaseViewer': (params) => releaseSessionViewer(params || {}),
  'transcripts.list': (params) => listTranscripts(params || {}),
  'files.stat': (params) => statPaths(params || {}),
};

export async function dispatch(method, params) {
  const fn = table[method];
  if (!fn) throw new RpcError('unsupported', `unknown method ${method}`, { method });
  return fn(params);
}
