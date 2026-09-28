import os from 'node:os';
import path from 'node:path';

const env = process.env;
const homeDir = env.HOME || os.homedir();
const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
const stateDir = env.MCW_STATE_DIR || path.join(configHome, 'maxclaude-web');
const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');

export const config = {
  hubUrl: env.MCW_HUB_URL || 'wss://hub.example.com/agent',
  stateDir,
  secretFile: env.MCW_SECRET_FILE || path.join(stateDir, 'tunnel.secret'),
  tokenFile: env.MCW_TOKEN_FILE || path.join(stateDir, 'zellij-token.json'),
  statusDir: env.MCW_STATUS_DIR || path.join(stateDir, 'session-status'),
  filesRoot: env.MCW_FILES_ROOT || path.join(stateDir, 'files'),
  projectsDir: env.MCW_PROJECTS_DIR || path.join(claudeDir, 'projects'),
  sessionEnvDir: env.MCW_SESSION_ENV_DIR || path.join(claudeDir, 'session-env'),
  zellijBin: env.MCW_ZELLIJ_BIN || path.join(homeDir, '.local', 'bin', 'zellij'),
  zellijConfig: env.MCW_ZELLIJ_CONFIG || path.join(configHome, 'zellij', 'config.kdl'),
  webHost: env.MCW_WEB_HOST || '127.0.0.1',
  webPort: Number(env.MCW_WEB_PORT || 8082),
  maxclaudeCfg: env.MCW_MAXCLAUDE_CFG || path.join(configHome, 'maxclaude'),
  transcriptDir: env.MCW_TRANSCRIPT_DIR || path.join(claudeDir, 'projects'),
  defaultWorkdir: env.MCW_DEFAULT_WORKDIR || homeDir,
  agentName: env.MCW_AGENT_NAME || os.hostname(),
  runtimeDir: env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`,
  version: 'maxclaude-web-agent/1.0.0',
  protocolVersion: 1,
  rpcTimeoutMs: 60000,
  createWaitMs: 20000,
  webWatchMs: 30000,
  statusWatchMs: 1000,
};

export const webOrigin = `http://${config.webHost}:${config.webPort}`;
export const webWsOrigin = `ws://${config.webHost}:${config.webPort}`;
