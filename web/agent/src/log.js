const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[process.env.MCW_LOG_LEVEL || 'info'] || levels.info;

function emit(level, msg, extra) {
  if (levels[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
};
