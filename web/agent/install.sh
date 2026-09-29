#!/usr/bin/env bash
# Install the maxclaude web agent for the current user.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_DIR="${MCW_STATE_DIR:-$CONFIG_HOME/maxclaude-web}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BIN_DIR="${MCW_BIN_DIR:-$HOME/.local/bin}"
INSTALL_ROOT="${MCW_INSTALL_ROOT:-$HOME/.local/share/maxclaude/web/agent}"
SECRET_FILE="${MCW_SECRET_FILE:-$STATE_DIR/tunnel.secret}"
ENV_FILE="$STATE_DIR/agent.env"
START=1
HOOKS=0

for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --install-hooks) HOOKS=1 ;;
    -h|--help) echo 'Usage: install.sh [--no-start] [--install-hooks]'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }

install -d -m 700 "$STATE_DIR"
install -d -m 700 "$(dirname "$SECRET_FILE")"
install -d -m 755 "$UNIT_DIR" "$BIN_DIR" "$INSTALL_ROOT"
install -m 755 "$HERE/bin/mcw-session-status" "$BIN_DIR/mcw-session-status"

if [ "$HOOKS" = 1 ]; then
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" node "$HERE/bin/install-hooks.mjs" "$BIN_DIR/mcw-session-status"
fi

if [ -z "${MCW_HUB_URL:-}" ] || [ -z "${MCW_AGENT_SECRET:-}" ]; then
  if [ "$HOOKS" = 1 ]; then echo 'installed status hooks'; exit 0; fi
  echo 'MCW_HUB_URL and MCW_AGENT_SECRET are required for agent installation' >&2
  exit 1
fi

umask 077
printf '%s\n' "$MCW_AGENT_SECRET" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

write_env() {
  local name="$1" value="$2"
  case "$value" in
    *$'\n'*|*$'\r'*) echo "$name cannot contain a newline" >&2; exit 1 ;;
  esac
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s="%s"\n' "$name" "$value"
}

umask 077
{
  write_env MCW_HUB_URL "$MCW_HUB_URL"
  write_env MCW_STATE_DIR "$STATE_DIR"
  write_env MCW_SECRET_FILE "$SECRET_FILE"
  for name in MCW_TOKEN_FILE MCW_STATUS_DIR MCW_FILES_ROOT MCW_PROJECTS_DIR \
    MCW_SESSION_ENV_DIR MCW_ZELLIJ_BIN MCW_ZELLIJ_CONFIG MCW_WEB_HOST \
    MCW_WEB_PORT MCW_MAXCLAUDE_CFG MCW_MAXAGENT_CFG MCW_MAXCLAUDE_BIN \
    MCW_TRANSCRIPT_DIR MCW_DEFAULT_WORKDIR MCW_AUTO_HIBERNATE_HOURS \
    MCW_AGENT_NAME CLAUDE_CONFIG_DIR XDG_RUNTIME_DIR; do
    if [ -n "${!name:-}" ]; then write_env "$name" "${!name}"; fi
  done
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "wrote $ENV_FILE"

cp -a "$HERE/." "$INSTALL_ROOT/"
( cd "$INSTALL_ROOT" && npm install --omit=dev --no-audit --no-fund )

service_escape() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*) echo 'service paths cannot contain a newline' >&2; exit 1 ;;
  esac
  value="${value//\\/\\x5c}"
  value="${value// /\\x20}"
  value="${value//$'\t'/\\x09}"
  value="${value//\"/\\x22}"
  value="${value//\'/\\x27}"
  value="${value//#/\\x23}"
  value="${value//;/\\x3b}"
  value="${value//&/\\&}"
  value="${value//|/\\|}"
  printf '%s' "$value"
}
escaped_root="$(service_escape "$INSTALL_ROOT")"
escaped_env="$(service_escape "$ENV_FILE")"
sed \
  -e "s|@INSTALL_ROOT@|$escaped_root|g" \
  -e "s|@ENV_FILE@|$escaped_env|g" \
  "$HERE/mcw-agent.service" > "$UNIT_DIR/mcw-agent.service"
chmod 644 "$UNIT_DIR/mcw-agent.service"

if command -v loginctl >/dev/null 2>&1; then
  current_user="$(id -un)"
  if ! loginctl enable-linger "$current_user" >/dev/null 2>&1; then
    echo "warning: could not enable lingering for $current_user; the agent may stop after logout" >&2
  fi
fi
systemctl --user daemon-reload
systemctl --user enable mcw-agent.service

if [ "$START" = 1 ]; then
  systemctl --user restart mcw-agent.service
  sleep 2
  systemctl --user --no-pager --full status mcw-agent.service | head -20
fi

# maxclaude session units are started on demand and must never gain an [Install]
# section, so this install deliberately enables nothing but mcw-agent itself.
echo "installed maxclaude web agent. logs: journalctl --user -u mcw-agent.service -f"
