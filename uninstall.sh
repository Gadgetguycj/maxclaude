#!/usr/bin/env bash
# maxagent uninstaller. Stops running sessions and removes files the installer
# created. Leaves zellij itself in place unless --remove-zellij is passed.
#
# Options:
#   --remove-zellij            also delete ~/.local/bin/zellij
#   --keep-legacy-maxclaude    keep the maxclaude command and ~/.config/maxclaude
#   -h, --help                 show this help
set -euo pipefail

BIN_DIR="$HOME/.local/bin"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
LAYOUT_DIR="$CFG_DIR/zellij/layouts"
UNIT_DIR="$CFG_DIR/systemd/user"
REMOVE_ZELLIJ=""
KEEP_LEGACY=""

for a in "$@"; do
  case "$a" in
    --remove-zellij) REMOVE_ZELLIJ=1 ;;
    --keep-legacy-maxclaude) KEEP_LEGACY=1 ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  esac
done

if [ -x "$BIN_DIR/maxagent" ]; then
  "$BIN_DIR/maxagent" close all >/dev/null 2>&1 || true
elif [ -x "$BIN_DIR/maxclaude" ]; then
  "$BIN_DIR/maxclaude" close all >/dev/null 2>&1 || true
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user list-units 'maxagent-named@*' 'maxclaude@*' 'maxclaude-named@*' --all --no-legend 2>/dev/null | awk '{print $1}' \
    | while read -r u; do systemctl --user disable --now "$u" >/dev/null 2>&1 || true; done
  for n in 1 2 3 4; do systemctl --user disable --now "maxclaude@${n}.service" >/dev/null 2>&1 || true; done
fi

rm -f "$BIN_DIR/maxagent" "$BIN_DIR/maxcodex" "$BIN_DIR/maxagent-pane" "$BIN_DIR/maxagent-svc"
if [ -z "$KEEP_LEGACY" ]; then
  rm -f "$BIN_DIR/maxclaude" "$BIN_DIR/maxclaude-svc" "$BIN_DIR/maxclaude-pane"
fi
rm -f "$LAYOUT_DIR"/agent{1,2,3,4}.kdl
rm -f "$LAYOUT_DIR"/cc{1,2,3,4}.kdl
rm -f "$UNIT_DIR/maxagent-named@.service"
if [ -z "$KEEP_LEGACY" ]; then
  rm -f "$UNIT_DIR/maxclaude@.service" "$UNIT_DIR/maxclaude-named@.service"
  rm -rf "$CFG_DIR/maxclaude"
fi
rm -rf "$CFG_DIR/maxagent"
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null || true

if [ -n "$REMOVE_ZELLIJ" ]; then rm -f "$BIN_DIR/zellij"; echo "removed $BIN_DIR/zellij"; fi
echo "maxagent uninstalled. (PATH line in your shell rc, if added, was left in place.)"
