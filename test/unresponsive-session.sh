#!/usr/bin/env bash
# pass and fail always return 0, so "check && pass || fail" reports exactly one.
# shellcheck disable=SC2015
# Regression test: a zellij server that keeps its socket but never answers must
# not hang maxclaude/maxagent. The launcher must return promptly, name the
# stuck session, keep the healthy session attachable, end the stuck one on
# request, and hide a stuck session by ending its server. The units' stop
# command must end a server that stopped answering since the last check, and a
# server that accepted the request to end and then stalled while shutting down.
#
# It reproduces the failure by stopping three servers with SIGSTOP, and the
# stalled shutdown by delaying a server's file deletions with strace. zellij runs in
# a private socket, cache and config directory, and systemctl --user is cut off,
# so no real session or unit is touched.
#
#   test/unresponsive-session.sh <dir with maxclaude, maxclaude-svc, maxagent, maxagent-zj>
#
# Needs Linux, zellij, and script(1) from util-linux. The stalled-shutdown case
# also needs strace and is skipped without it. Exits non-zero on failure.

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
HIDE=mzt-hide
SVC=mzt-svc
WEDGE=mzt-wedge
FAILS=0
STUCK_PID=""
HIDE_PID=""
SVC_PID=""
OK_PID=""
WEDGE_PID=""
STRACE_PID=""

cleanup(){
  [ -n "$STRACE_PID" ] && kill "$STRACE_PID" 2>/dev/null
  for p in $STUCK_PID $HIDE_PID $SVC_PID; do kill -CONT "$p" 2>/dev/null; done
  for p in $STUCK_PID $HIDE_PID $SVC_PID $OK_PID $WEDGE_PID; do kill -KILL "$p" 2>/dev/null; done
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
HIDE_PID="$(start_session "$HIDE")"
SVC_PID="$(start_session "$SVC")"
WEDGE_PID="$(start_session "$WEDGE")"
[ -n "$OK_PID" ] && [ -n "$STUCK_PID" ] && [ -n "$HIDE_PID" ] && [ -n "$SVC_PID" ] && [ -n "$WEDGE_PID" ] || { echo "could not start test sessions" >&2; exit 2; }
sleep 1
echo "test sessions: $OK (pid $OK_PID), $STUCK (pid $STUCK_PID), $HIDE (pid $HIDE_PID), $SVC (pid $SVC_PID), $WEDGE (pid $WEDGE_PID)"
kill -STOP "$STUCK_PID" "$HIDE_PID"
echo "stopped $STUCK server pid $STUCK_PID and $HIDE server pid $HIDE_PID with SIGSTOP"

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
grep -qE "$HIDE .*$HIDE_PID" "$T/ls.out" && pass "ls names $HIDE and its server pid $HIDE_PID" || fail "ls does not name $HIDE with pid $HIDE_PID"

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

# 4. Hiding a stuck session ends its server and keeps the session listed as hidden.
run "maxclaude hide $HIDE" hide.out "$BIN/maxclaude" hide "$HIDE" && pass "hide $HIDE returned 0" || fail "hide $HIDE failed or did not return"
grep -q SIGKILL "$T/hide.out" && pass "hide $HIDE ended the stuck server with SIGKILL" || fail "hide $HIDE did not report SIGKILL"
sleep 0.5
if kill -0 "$HIDE_PID" 2>/dev/null; then fail "$HIDE server (pid $HIDE_PID) still runs after hide"; else pass "$HIDE server (pid $HIDE_PID) is gone"; HIDE_PID=""; fi
[ ! -e "$SOCK_DIR/$HIDE" ] && [ ! -e "$XDG_RUNTIME_DIR/zellij/stuck/$HIDE" ] && pass "no socket left for $HIDE" || fail "a socket for $HIDE is left behind"
run "maxclaude ls after hide" ls2.out "$BIN/maxclaude" ls && pass "maxclaude ls returned after hide" || fail "maxclaude ls did not return after hide"
sed -n '/^hidden:/,/^[^ ]/p' "$T/ls2.out" | grep -qE "^ +$HIDE +\[" && pass "ls lists $HIDE under hidden" || fail "ls does not list $HIDE under hidden"

# 5. Closing the stuck session ends its server.
run "maxclaude close $STUCK" close.out "$BIN/maxclaude" close "$STUCK" && pass "close $STUCK returned" || fail "close $STUCK did not return"
sleep 0.5
if kill -0 "$STUCK_PID" 2>/dev/null; then fail "$STUCK server (pid $STUCK_PID) still runs"; else pass "$STUCK server (pid $STUCK_PID) is gone"; STUCK_PID=""; fi
[ ! -e "$SOCK_DIR/$STUCK" ] && [ ! -e "$XDG_RUNTIME_DIR/zellij/stuck/$STUCK" ] && pass "no socket left for $STUCK" || fail "a socket for $STUCK is left behind"

# 6. The units' stop command ends a server that stopped answering after the
# last check, while its socket is still in zellij's socket directory.
kill -STOP "$SVC_PID"
echo "stopped $SVC server pid $SVC_PID with SIGSTOP"
run "maxclaude-svc stop $SVC" svcstop.out "$BIN/maxclaude-svc" stop "$SVC" && pass "maxclaude-svc stop $SVC returned 0" || fail "maxclaude-svc stop $SVC failed or did not return"
sleep 0.5
if kill -0 "$SVC_PID" 2>/dev/null; then fail "$SVC server (pid $SVC_PID) still runs"; else pass "$SVC server (pid $SVC_PID) is gone"; SVC_PID=""; fi
[ ! -e "$SOCK_DIR/$SVC" ] && [ ! -e "$XDG_RUNTIME_DIR/zellij/stuck/$SVC" ] && pass "no socket left for $SVC" || fail "a socket for $SVC is left behind"

# 7. Stopping a healthy session is a clean exit, not a kill.
run "maxagent-zj stop $OK" stop.out "$BIN/maxagent-zj" stop "$OK" && pass "stop $OK returned 0" || fail "stop $OK failed"
grep -q SIGKILL "$T/stop.out" && fail "stop $OK needed SIGKILL" || pass "stop $OK ended without SIGKILL"
kill -0 "$OK_PID" 2>/dev/null && fail "$OK server still runs after stop" || { pass "$OK server exited"; OK_PID=""; }

# 8. The units' stop command ends a server that accepted the request to end and
# then stalled while shutting down, the way a broken plugin stalled one. strace
# delays the server's unlink calls by 120 s. Servers left over from failed
# checks above are ended first so this check stands on its own.
if command -v strace >/dev/null 2>&1; then
  for p in $STUCK_PID $HIDE_PID $SVC_PID; do kill -KILL "$p" 2>/dev/null; done
  STUCK_PID="" HIDE_PID="" SVC_PID=""
  for s in "$STUCK" "$HIDE" "$SVC"; do rm -f "$SOCK_DIR/$s" "$XDG_RUNTIME_DIR/zellij/stuck/$s"; done
  strace -f -p "$WEDGE_PID" -e trace=unlink,unlinkat,rmdir -e inject=unlink,unlinkat,rmdir:delay_enter=120s -o /dev/null &
  STRACE_PID=$!
  sleep 1.5
  echo "$WEDGE server pid $WEDGE_PID; strace (pid $STRACE_PID) delays its unlink calls by 120 s"
  run "maxclaude-svc stop $WEDGE" wedge.out "$BIN/maxclaude-svc" stop "$WEDGE" && pass "maxclaude-svc stop $WEDGE returned 0" || fail "maxclaude-svc stop $WEDGE failed or did not return"
  sleep 1
  st="$(ps -o stat= -p "$WEDGE_PID" 2>/dev/null | tr -d ' ')"
  case "$st" in
    ''|Z*) pass "$WEDGE server (pid $WEDGE_PID) exited after stop returned" ;;
    *) fail "$WEDGE server (pid $WEDGE_PID) still runs after stop returned (state $st)" ;;
  esac
  grep -q SIGKILL "$T/wedge.out" && pass "stop $WEDGE reported the SIGKILL" || fail "stop $WEDGE did not report a SIGKILL"
  [ ! -e "$SOCK_DIR/$WEDGE" ] && pass "no socket left for $WEDGE" || fail "a socket for $WEDGE is left behind"
  # No session is left, so zellij answers "No active zellij sessions found." with exit 1.
  run "zellij list-sessions after stop $WEDGE" zls2.out "$ZJ" list-sessions -n
  rc=$?
  [ "$rc" != 137 ] && pass "zellij list-sessions answers after the stalled shutdown (exit $rc)" || fail "zellij list-sessions hangs after the stalled shutdown"
  kill "$STRACE_PID" 2>/dev/null
  STRACE_PID=""
else
  echo "SKIP: strace not found; the stalled-shutdown case was not run"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL ($FAILS checks failed)"; fi
[ "$FAILS" -eq 0 ]
