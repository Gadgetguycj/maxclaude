#!/usr/bin/env bash
# pass and fail always return 0, so "check && pass || fail" reports exactly one.
# shellcheck disable=SC2015
# Regression test: a zellij server that keeps its socket but never answers must
# not hang maxclaude/maxagent. The launcher must return promptly, name the
# stuck session, keep the healthy session attachable, and end the stuck one on
# request.
#
# It reproduces the failure by stopping one server with SIGSTOP. zellij runs in
# a private socket, cache and config directory, and systemctl --user is cut off,
# so no real session or unit is touched.
#
#   test/unresponsive-session.sh <dir with maxclaude, maxagent, maxagent-zj>
#
# Needs Linux, zellij, and script(1) from util-linux. Exits non-zero on failure.

set -uo pipefail

BIN="${1:?usage: unresponsive-session.sh <bin dir>}"
BIN="$(cd "$BIN" && pwd)"
ZJ="${MAXAGENT_ZELLIJ:-$(command -v zellij || echo "$HOME/.local/bin/zellij")}"
[ -x "$ZJ" ] || { echo "zellij not found" >&2; exit 2; }
LIMIT="${TEST_LIMIT_SECONDS:-20}"

T="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/mzt.XXXXXX")"
export XDG_RUNTIME_DIR="$T/rt" XDG_CACHE_HOME="$T/cache" XDG_CONFIG_HOME="$T/config"
# zellij reads ~/.config/zellij before $XDG_CONFIG_HOME; pin it to the private config.
export ZELLIJ_CONFIG_DIR="$XDG_CONFIG_HOME/zellij"
export MAXAGENT_ZELLIJ="$ZJ" MAXCLAUDE_ZELLIJ="$ZJ"
unset DBUS_SESSION_BUS_ADDRESS ZELLIJ ZELLIJ_SESSION_NAME ZELLIJ_PANE_ID ZELLIJ_SOCKET_DIR
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME/zellij"
chmod 700 "$XDG_RUNTIME_DIR"
SOCK_DIR="$XDG_RUNTIME_DIR/zellij/contract_version_1"
OK=mzt-ok
STUCK=mzt-stuck
FAILS=0
STUCK_PID=""
OK_PID=""

cleanup(){
  [ -n "$STUCK_PID" ] && kill -CONT "$STUCK_PID" 2>/dev/null
  for p in $STUCK_PID $OK_PID; do kill -KILL "$p" 2>/dev/null; done
  rm -rf "$T"
}
trap cleanup EXIT

pass(){ echo "PASS: $1"; }
fail(){ echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
now(){ date +%s.%N; }
since(){ awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }

# Never run against the real user manager.
if systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemctl --user still reaches a user manager; refusing to run" >&2
  exit 2
fi

cat >"$XDG_CONFIG_HOME/zellij/config.kdl" <<'EOF'
show_startup_tips false
show_release_notes false
EOF
cat >"$T/layout.kdl" <<'EOF'
layout {
    pane command="sh" {
        args "-c" "echo SESSION-READY; exec sleep 86400"
    }
}
EOF

server_pid(){ pgrep -f -- "--server $SOCK_DIR/$1\$" | head -n 1; }
start_session(){
  "$ZJ" --layout "$T/layout.kdl" attach --create-background "$1" </dev/null >/dev/null 2>&1
  local i=0
  while [ -z "$(server_pid "$1")" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  server_pid "$1"
}

OK_PID="$(start_session "$OK")"
STUCK_PID="$(start_session "$STUCK")"
[ -n "$OK_PID" ] && [ -n "$STUCK_PID" ] || { echo "could not start test sessions" >&2; exit 2; }
sleep 1
echo "test sessions: $OK (pid $OK_PID), $STUCK (pid $STUCK_PID)"
kill -STOP "$STUCK_PID"
echo "stopped $STUCK server pid $STUCK_PID with SIGSTOP"

# Run a command under a hard limit; a hang is reported, never waited out.
run(){
  local label="$1" out="$T/$2" t rc
  shift 2
  t="$(now)"
  timeout -s KILL "$LIMIT" "$@" >"$out" 2>&1 </dev/null
  rc=$?
  echo "--- $label: exit $rc after $(since "$t")s"
  sed 's/^/    /' "$out"
  return "$rc"
}

# 1. ls returns, lists the healthy session, and names the stuck one with its pid.
if run "maxclaude ls" ls.out "$BIN/maxclaude" ls; then
  pass "maxclaude ls returned"
else
  fail "maxclaude ls did not return within ${LIMIT}s (it hung on the stuck server)"
fi
grep -qE "^ +[0-9]+\) +$OK " "$T/ls.out" && pass "ls lists $OK as a running session" || fail "ls does not list $OK"
grep -qE "$STUCK .*$STUCK_PID" "$T/ls.out" && pass "ls names $STUCK and its server pid $STUCK_PID" || fail "ls does not name $STUCK with pid $STUCK_PID"

# 2. Plain zellij works again for everything else on the machine.
if run "zellij list-sessions" zls.out "$ZJ" list-sessions -n; then
  pass "zellij list-sessions answers while $STUCK is still stopped"
else
  fail "zellij list-sessions still hangs"
fi

# 3. The healthy session still attaches through the launcher.
t="$(now)"
timeout -s KILL 6 script -qfec "$BIN/maxclaude attach $OK" "$T/attach.typescript" </dev/null >/dev/null 2>&1
echo "--- maxclaude attach $OK: client ran for $(since "$t")s (ended by the test)"
if grep -q SESSION-READY "$T/attach.typescript"; then
  pass "maxclaude attach $OK showed the session's pane (SESSION-READY)"
else
  fail "maxclaude attach $OK did not show the session"
fi
kill -0 "$OK_PID" 2>/dev/null && pass "$OK server (pid $OK_PID) still runs" || fail "$OK server died"

# 4. Closing the stuck session ends its server.
run "maxclaude close $STUCK" close.out "$BIN/maxclaude" close "$STUCK" && pass "close $STUCK returned" || fail "close $STUCK did not return"
sleep 0.5
if kill -0 "$STUCK_PID" 2>/dev/null; then fail "$STUCK server (pid $STUCK_PID) still runs"; else pass "$STUCK server (pid $STUCK_PID) is gone"; STUCK_PID=""; fi
[ ! -e "$SOCK_DIR/$STUCK" ] && [ ! -e "$XDG_RUNTIME_DIR/zellij/stuck/$STUCK" ] && pass "no socket left for $STUCK" || fail "a socket for $STUCK is left behind"

# 5. Stopping a healthy session is a clean exit, not a kill.
run "maxagent-zj stop $OK" stop.out "$BIN/maxagent-zj" stop "$OK" && pass "stop $OK returned 0" || fail "stop $OK failed"
grep -q SIGKILL "$T/stop.out" && fail "stop $OK needed SIGKILL" || pass "stop $OK ended without SIGKILL"
kill -0 "$OK_PID" 2>/dev/null && fail "$OK server still runs after stop" || { pass "$OK server exited"; OK_PID=""; }

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL ($FAILS checks failed)"; fi
[ "$FAILS" -eq 0 ]
