#!/usr/bin/env bash
# pass and fail always return 0, so "check && pass || fail" reports exactly one.
# shellcheck disable=SC2015
# Regression test: a zellij server that keeps its socket but never answers must
# not hang the maxrouter tools. mxr, mxr-notify, mxr-blockd and
# maxclaude-restore must return promptly, keep working for the healthy
# sessions, and name the session that stopped answering. mxr close must end a
# pane session whose server stopped answering, and one whose server accepted
# the request to end and then stalled while shutting down.
#
# A server is stopped with SIGSTOP. Before each check its socket is put back in
# zellij's socket directory: the state right after a server stops answering,
# before anything has set it aside. zellij runs in a private socket, cache,
# config and home directory, and systemctl --user is cut off, so no real
# session, unit or router is touched.
#
#   test/router-unresponsive-session.sh <dir with mxr, mxr-notify, mxr-blockd, maxclaude-restore, maxagent-zj>
#
# Needs Linux, zellij and jq. The stalled-shutdown case also needs strace and
# is skipped without it. Exits non-zero on failure.

set -uo pipefail

BIN="${1:?usage: router-unresponsive-session.sh <bin dir>}"
BIN="$(cd "$BIN" && pwd)"
ZJ="${MAXAGENT_ZELLIJ:-$(command -v zellij || echo "$HOME/.local/bin/zellij")}"
[ -x "$ZJ" ] || { echo "zellij not found" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 2; }
LIMIT="${TEST_LIMIT_SECONDS:-25}"

T="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/mzr.XXXXXX")"
mkdir -p "$T/zbin" "$T/home" "$T/work"
ln -s "$ZJ" "$T/zbin/zellij"
export HOME="$T/home" PATH="$T/zbin:$PATH"
export XDG_RUNTIME_DIR="$T/rt" XDG_CACHE_HOME="$T/cache" XDG_CONFIG_HOME="$T/config"
# zellij reads ~/.config/zellij before $XDG_CONFIG_HOME; pin it to the private config.
export ZELLIJ_CONFIG_DIR="$XDG_CONFIG_HOME/zellij" CLAUDE_CONFIG_DIR="$T/claude"
export MAXAGENT_ZELLIJ="$ZJ" MAXCLAUDE_ZELLIJ="$ZJ" MAXROUTER_NOTIFY_SESSION=router
unset DBUS_SESSION_BUS_ADDRESS ZELLIJ ZELLIJ_SESSION_NAME ZELLIJ_PANE_ID ZELLIJ_SOCKET_DIR MAXROUTER_CONFIG_HOME
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$ZELLIJ_CONFIG_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
SOCK_DIR="$XDG_RUNTIME_DIR/zellij/contract_version_1"
STUCK_DIR="$XDG_RUNTIME_DIR/zellij/stuck"
CFG="$XDG_CONFIG_HOME/maxclaude"
FAILS=0
PIDS=""
STRACE_PID=""

cleanup(){
  [ -n "$STRACE_PID" ] && kill "$STRACE_PID" 2>/dev/null
  for p in $PIDS; do kill -CONT "$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; done
  rm -rf "$T"
}
trap cleanup EXIT

pass(){ echo "PASS: $1"; }
fail(){ echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
now(){ date +%s.%N; }
since(){ awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }

if systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemctl --user still reaches a user manager; refusing to run" >&2
  exit 2
fi

printf 'show_startup_tips false\nshow_release_notes false\n' >"$ZELLIJ_CONFIG_DIR/config.kdl"
layout(){
  printf 'layout {\n    pane command="sh" {\n        args "-c" "%s"\n    }\n}\n' "$2" >"$T/$1.kdl"
}
layout cat 'echo PANE-READY; exec cat'
layout menu 'printf \"Do you want to proceed?\\n  1. Yes\\n  2. No\\n\"; exec sleep 86400'

server_pid(){ pgrep -f -- "--server $SOCK_DIR/$1\$" | head -n 1; }
start_session(){
  "$ZJ" --layout "$T/$2.kdl" attach --create-background "$1" </dev/null >/dev/null 2>&1
  local i=0
  while [ -z "$(server_pid "$1")" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  server_pid "$1"
}

ROUTER_PID="$(start_session router cat)"
OK_PID="$(start_session task-ok cat)"
MENU_PID="$(start_session task-menu menu)"
FROZEN_PID="$(start_session task-frozen cat)"
WEDGE_PID="$(start_session task-wedge cat)"
PIDS="$ROUTER_PID $OK_PID $MENU_PID $FROZEN_PID $WEDGE_PID"
for p in $PIDS; do [ -n "$p" ] || { echo "could not start test sessions" >&2; exit 2; }; done
sleep 1.5

mkdir -p "$CFG"
jq -n --arg wd "$T/work" '{tasks: {
  ok:     {org: "Test", sid: "00000000-0000-4000-8000-000000000001", mode: "paned", status: "active", workdir: $wd, desc: "healthy pane"},
  menu:   {org: "Test", sid: "00000000-0000-4000-8000-000000000002", mode: "paned", status: "active", workdir: $wd, desc: "pane showing a prompt"},
  frozen: {org: "Test", sid: "00000000-0000-4000-8000-000000000003", mode: "paned", status: "active", workdir: $wd, desc: "pane whose server stopped"},
  wedge:  {org: "Test", sid: "00000000-0000-4000-8000-000000000004", mode: "paned", status: "active", workdir: $wd, desc: "pane whose server stalls in shutdown"}}}' >"$CFG/registry.json"
# mxr reads conversations from ~/.claude; maxclaude-restore from $CLAUDE_CONFIG_DIR.
slug="$(printf '%s' "$T/work" | sed 's|[^A-Za-z0-9]|-|g')"
for d in "$HOME/.claude" "$CLAUDE_CONFIG_DIR"; do
  mkdir -p "$d/projects/$slug"
  for n in 1 2 3 4; do : >"$d/projects/$slug/00000000-0000-4000-8000-00000000000$n.jsonl"; done
done

kill -STOP "$FROZEN_PID"
echo "sessions: router (pid $ROUTER_PID), task-ok (pid $OK_PID), task-menu (pid $MENU_PID), task-wedge (pid $WEDGE_PID), task-frozen (pid $FROZEN_PID, stopped with SIGSTOP)"

# Put set-aside sockets back where zellij looks for them.
restuck(){
  local s
  for s in "$@"; do
    if [ -S "$STUCK_DIR/$s" ]; then
      mv -f "$STUCK_DIR/$s" "$SOCK_DIR/$s"
      rm -f "$STUCK_DIR.info/$s"
    fi
  done
}

# Run a command under a hard limit; a hang is reported, never waited out.
run(){
  local label="$1" out="$T/$2" lim="$3" t rc
  shift 3
  t="$(now)"
  timeout -s KILL "$lim" "$@" >"$out" 2>&1 </dev/null
  rc=$?
  echo "--- $label: exit $rc after $(since "$t")s$([ "$rc" = 137 ] && echo ", killed by the ${lim}s test limit")"
  sed 's/^/    /' "$out" | tail -n 25
  return "$rc"
}

# The screen of a pane, read without zellij's discovery touching other servers.
screen(){
  local view
  view="$(mktemp -d "$XDG_RUNTIME_DIR/zellij/.view.XXXXXX")"
  mkdir "$view/contract_version_1"
  ln "$SOCK_DIR/$1" "$view/contract_version_1/$1" 2>/dev/null
  timeout -s KILL 5 env ZELLIJ_SOCKET_DIR="$view" "$ZJ" --session "$1" action dump-screen --full -p terminal_0 </dev/null 2>/dev/null
  rm -rf "$view"
}

# 0. The failure this test guards against: zellij itself hangs.
run "zellij list-sessions (expected to hang)" zls.out 5 "$ZJ" list-sessions -n
[ $? = 137 ] && echo "    the stopped server blocks zellij's own discovery, as expected" || echo "    note: zellij list-sessions did not hang"

# 1. mxr status
restuck task-frozen
run "mxr status" status.out "$LIMIT" "$BIN/mxr" status && pass "mxr status returned" || fail "mxr status did not return"
grep -q 'zellij sessions:.*task-ok' "$T/status.out" && pass "mxr status lists task-ok" || fail "mxr status does not list task-ok"
grep -qE "task-frozen .*$FROZEN_PID" "$T/status.out" && pass "mxr status names task-frozen and its server pid as not responding" || fail "mxr status does not name task-frozen with pid $FROZEN_PID"

# 2. mxr health
restuck task-frozen
run "mxr health" health.out "$LIMIT" "$BIN/mxr" health && pass "mxr health returned" || fail "mxr health did not return"
grep -qE '^STUCK +frozen ' "$T/health.out" && pass "mxr health shows frozen as STUCK" || fail "mxr health does not show frozen as STUCK"
grep -qE '^BLOCKED +menu ' "$T/health.out" && pass "mxr health still reads task-menu's screen (BLOCKED)" || fail "mxr health did not read task-menu"

# 3. mxr peek
restuck task-frozen
run "mxr peek ok" peek.out "$LIMIT" "$BIN/mxr" peek ok && pass "mxr peek ok returned" || fail "mxr peek ok did not return"
grep -q PANE-READY "$T/peek.out" && pass "mxr peek ok shows the pane" || fail "mxr peek ok did not show the pane"

# 4. mxr send to a healthy pane
restuck task-frozen
run "mxr send ok --async" send.out "$LIMIT" "$BIN/mxr" send ok --async hello-from-test && pass "mxr send ok returned 0" || fail "mxr send ok failed or did not return"
sleep 0.5
screen task-ok | grep -q hello-from-test && pass "the message reached task-ok's pane" || fail "the message did not reach task-ok's pane"

# 5. mxr send to the stopped pane
restuck task-frozen
run "mxr send frozen" sendf.out "$LIMIT" "$BIN/mxr" send frozen hello
rc=$?
[ "$rc" != 0 ] && [ "$rc" != 137 ] && pass "mxr send frozen failed promptly (exit $rc)" || fail "mxr send frozen did not fail promptly (exit $rc)"
grep -q "task-frozen is not responding" "$T/sendf.out" && pass "mxr send frozen names task-frozen as not responding" || fail "mxr send frozen does not name task-frozen"
jq -e '.tasks.frozen.mode == "paned"' "$CFG/registry.json" >/dev/null && pass "frozen stays paned (no second headless turn)" || fail "frozen was demoted to headless"

# 6. mxr-notify into a healthy router
restuck task-frozen
run "mxr-notify raw ok" notify.out "$LIMIT" "$BIN/mxr-notify" raw ok PUSH-ONE && pass "mxr-notify returned 0" || fail "mxr-notify failed or did not return"
sleep 0.5
screen router | grep -q PUSH-ONE && pass "the push reached the router pane" || fail "the push did not reach the router pane"

# 7. mxr-blockd: one scan pushes task-menu's prompt and names task-frozen
restuck task-frozen
run "mxr-blockd (daemon, ended by the test)" blockd.out 30 "$BIN/mxr-blockd"
screen router | grep -q "worker 'menu' is BLOCKED" && pass "mxr-blockd pushed task-menu's prompt to the router" || fail "mxr-blockd did not push task-menu's prompt"
grep -q "worker pane task-frozen is not responding (zellij server pid $FROZEN_PID)" "$T/blockd.out" && pass "mxr-blockd names task-frozen and its server pid" || fail "mxr-blockd does not name task-frozen"

# 8. maxclaude-restore skips the stopped session instead of hanging or starting a second copy
restuck task-frozen
printf 'task-ok\t00000000-0000-4000-8000-000000000001\t%s\t1\ntask-frozen\t00000000-0000-4000-8000-000000000003\t%s\t1\n' "$T/work" "$T/work" >"$CFG/restore.tsv"
run "maxclaude-restore" restore.out "$LIMIT" "$BIN/maxclaude-restore" && pass "maxclaude-restore returned 0" || fail "maxclaude-restore failed or did not return"
grep -q '^LIVE task-ok' "$T/restore.out" && pass "maxclaude-restore sees task-ok as live" || fail "maxclaude-restore does not see task-ok"
grep -q '^STUCK task-frozen' "$T/restore.out" && pass "maxclaude-restore names task-frozen as stuck" || fail "maxclaude-restore does not name task-frozen"

# 9. mxr open refuses the stopped pane
restuck task-frozen
run "mxr open frozen" open.out "$LIMIT" "$BIN/mxr" open frozen
rc=$?
[ "$rc" != 0 ] && [ "$rc" != 137 ] && grep -q "not responding" "$T/open.out" && pass "mxr open frozen refused and named the session (exit $rc)" || fail "mxr open frozen did not refuse promptly (exit $rc)"

# 10. mxr close ends the stopped pane session
restuck task-frozen
run "mxr close frozen" close.out "$LIMIT" "$BIN/mxr" close frozen && pass "mxr close frozen returned 0" || fail "mxr close frozen failed or did not return"
sleep 0.5
if kill -0 "$FROZEN_PID" 2>/dev/null; then fail "task-frozen server (pid $FROZEN_PID) still runs"; else pass "task-frozen server (pid $FROZEN_PID) is gone"; fi
[ ! -e "$SOCK_DIR/task-frozen" ] && [ ! -e "$STUCK_DIR/task-frozen" ] && pass "no socket left for task-frozen" || fail "a socket for task-frozen is left behind"

# 11. mxr-notify into a router that stopped answering
kill -STOP "$ROUTER_PID"
echo "stopped router server pid $ROUTER_PID with SIGSTOP"
run "mxr-notify raw ok (router stopped)" notify2.out "$LIMIT" "$BIN/mxr-notify" raw ok PUSH-TWO
rc=$?
[ "$rc" != 0 ] && [ "$rc" != 137 ] && pass "mxr-notify failed promptly (exit $rc)" || fail "mxr-notify did not fail promptly (exit $rc)"
grep -q "router session 'router' is not responding" "$T/notify2.out" && pass "mxr-notify names the router as not responding" || fail "mxr-notify does not name the router"
run "maxagent-zj run task-ok dump-screen (router stopped)" zjrun.out "$LIMIT" "$BIN/maxagent-zj" run task-ok action dump-screen -p terminal_0 \
  && grep -q hello-from-test "$T/zjrun.out" && pass "maxagent-zj run reaches task-ok while the router is stopped" || fail "maxagent-zj run did not reach task-ok"
kill -CONT "$ROUTER_PID"

# 12. mxr close ends a pane session whose server accepted the request and then
# stalled while shutting down. strace delays the server's unlink calls by 120 s.
if command -v strace >/dev/null 2>&1; then
  strace -f -p "$WEDGE_PID" -e trace=unlink,unlinkat,rmdir -e inject=unlink,unlinkat,rmdir:delay_enter=120s -o /dev/null &
  STRACE_PID=$!
  sleep 1.5
  echo "task-wedge server pid $WEDGE_PID; strace delays its unlink calls by 120 s"
  run "mxr close wedge" closew.out 40 "$BIN/mxr" close wedge && pass "mxr close wedge returned 0" || fail "mxr close wedge failed or did not return"
  sleep 1
  st="$(ps -o stat= -p "$WEDGE_PID" 2>/dev/null | tr -d ' ')"
  case "$st" in ''|Z*) pass "task-wedge server (pid $WEDGE_PID) exited" ;; *) fail "task-wedge server (pid $WEDGE_PID) still runs (state $st)" ;; esac
  run "mxr status after wedge" status2.out "$LIMIT" "$BIN/mxr" status && pass "mxr status returned after the stalled shutdown" || fail "mxr status did not return after the stalled shutdown"
  kill "$STRACE_PID" 2>/dev/null
  STRACE_PID=""
else
  echo "SKIP: strace not found; the stalled-shutdown case was not run"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL ($FAILS checks failed)"; fi
[ "$FAILS" -eq 0 ]
