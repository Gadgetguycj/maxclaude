#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../bin/maxclaude-browser-reaper
source "$ROOT/bin/maxclaude-browser-reaper"

assert_eq() {
  [ "$1" = "$2" ] || { echo "expected $2, got $1" >&2; exit 1; }
}

assert_true() {
  "$@" || { echo "expected success: $*" >&2; exit 1; }
}

assert_false() {
  if "$@"; then echo "expected failure: $*" >&2; exit 1; fi
}

assert_eq "$(browser_limit_seconds 0)" 0
assert_eq "$(browser_limit_seconds 0.5)" 1800
assert_true is_expired 1800 1800
assert_false is_expired 1799 1800

test_tmp="$(mktemp -d)"
outside_tmp="$(mktemp -d /var/tmp/maxclaude-browser-reaper.XXXXXX)"
trap 'rm -rf "$test_tmp" "$outside_tmp"' EXIT
mkdir "$test_tmp/profile" "$outside_tmp/profile"
ln -s "$outside_tmp" "$test_tmp/escape"

assert_false is_temporary_headless "/usr/bin/chrome --headless --user-data-dir=$outside_tmp/profile"
assert_false is_expired 1799 "$(browser_limit_seconds 0.5)"
assert_true is_temporary_headless "/usr/bin/chrome --headless=new --user-data-dir=$test_tmp/profile"
assert_true is_temporary_headless "/usr/bin/chrome --headless --user-data-dir $test_tmp/profile"
assert_false is_temporary_headless "/usr/bin/chrome --headless --user-data-dir=$test_tmp/escape"
assert_true is_chrome_executable /usr/bin/chromium
assert_false is_chrome_executable /usr/bin/node
assert_true is_agent_browser_executable /usr/bin/agent-browser
assert_true is_agent_browser_executable /usr/bin/agent-browser-linux-x64
assert_false is_agent_browser_executable /usr/bin/sh
assert_eq "$(session_from_agent_browser_command 'worker --session sample-1')" sample-1
assert_false session_from_agent_browser_command 'worker --session invalid/name'
assert_true same_process "$$:$(process_stamp $$)"
assert_false same_process "$$:0"
grep -qx 'MAXCLAUDE_BROWSER_MAX_HOURS=0' <(sed -n "s/^.*MAXCLAUDE_BROWSER_MAX_HOURS=0.*$/MAXCLAUDE_BROWSER_MAX_HOURS=0/p" "$ROOT/install.sh")
grep -q 'EnvironmentFile=.*browser-reaper.env' "$ROOT/systemd/maxclaude-browser-reaper.service"
grep -q 'maxclaude-browser-reaper.timer' "$ROOT/install.sh"

echo 'browser reaper selection tests passed'
