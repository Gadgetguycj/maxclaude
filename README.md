# maxagent

Run **1-4 Codex or Claude panes in one terminal** with persistent zellij
sessions. This is useful on a Linux dev server: start multiple agent panes,
detach, close SSH, reconnect later, and attach to the same running workspace.

```bash
maxcodex          # one Codex pane
maxcodex 2        # two Codex panes
maxcodex work     # named Codex workspace
maxclaude         # one throwaway Claude pane
```

```
┌───────────────┬───────────────┐
│   agent #1    │   agent #2    │
├───────────────┼───────────────┤
│   agent #3    │   agent #4    │
└───────────────┴───────────────┘
        maxagent
```

## Install

One line, straight from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/Gadgetguycj/maxclaude/main/install.sh | bash
```

Or clone and run it:

```bash
git clone https://github.com/Gadgetguycj/maxclaude.git
cd maxclaude
./install.sh --provider codex --workdir "$HOME/Projects"
```

This runs interactively and prompts for the working directory and Claude's
permission mode. Add `--yes` to accept the defaults without prompting (see
[Non-Interactive Install](#non-interactive-install)).

The installer:

- installs `maxagent`, `maxcodex`, and the compatibility `maxclaude` command;
- installs zellij into `~/.local/bin` if zellij is missing;
- installs the pinned zjstatus plugin and enables zellij web sharing;
- writes provider profiles under `~/.config/maxagent/profiles`;
- installs the `agent{1,2,3,4}` and `cc{1,2,3,4}` zellij layouts;
- installs per-user systemd services on Linux when available;
- installs the router tools, restore command, web GUI, and seeded config;
- enables systemd lingering (`loginctl enable-linger`) on systemd hosts so
  sessions survive SSH disconnects;
- adds `~/.local/bin` to your shell startup file if needed.

### Non-Interactive Install

```bash
./install.sh --yes --provider codex --workdir "$HOME/Projects"
./install.sh --yes --provider codex --workdir "$HOME/Projects" --codex-sandbox workspace-write
./install.sh --yes --provider claude --workdir "$HOME/Projects" --yolo
```

| flag | meaning |
|------|---------|
| `--provider codex\|claude` | default provider for `maxagent` |
| `--workdir DIR` | directory each pane opens in |
| `--codex-profile NAME` | pass `--profile NAME` to Codex |
| `--codex-sandbox MODE` | pass `--sandbox MODE` to Codex |
| `--codex-approval POLICY` | pass `--ask-for-approval POLICY` to Codex |
| `--codex-dangerous-bypass` | make **every** Codex pane bypass approvals/sandbox (global). For a single session, use `--yolo` at start time instead |
| `--yolo`, `--skip-permissions`, `--dangerous` | configure Claude's default profile with `--dangerously-skip-permissions` |
| `--safe` | start Claude with normal permission prompts |
| `--zellij-version vX.Y.Z` | zellij release to fetch when missing |
| `--no-systemd` | skip systemd units; rely on zellij's own persistence |
| `--with-web-agent` | install the optional web agent after the core tools |
| `-y`, `--yes` | take defaults/flags without prompting |

Codex defaults are intentionally safe and interactive. Installing with
`--codex-dangerous-bypass` makes **all** Codex panes bypass approvals and the
sandbox; without it, the bypass is only applied to sessions you start with
`--yolo`.

At start time, `--yolo` (also accepted as `--dangerous` or `--skip-permissions`)
enables the provider's dangerous mode for that one session:

```bash
maxagent 4 --yolo
maxcodex 3 --yolo
maxcodex work --yolo
maxagent claude 2 --yolo
```

For Codex, this maps to `--dangerously-bypass-approvals-and-sandbox`. For
Claude, it maps to `--dangerously-skip-permissions`.

`--yolo` applies when the zellij session is created. If you already have a
running non-yolo session, close it first and reopen it:

```bash
maxagent close codex4
maxagent 4 --yolo
```

## Requirements

- **Codex CLI** for Codex panes. The installer checks normal `PATH`, a login
  shell PATH, and common nvm locations, then writes the resolved command into
  `~/.config/maxagent/profiles/codex.sh`.
- **Claude Code** for Claude panes. Claude is optional if you only use Codex.
- **zellij**. Installed automatically if missing.
- **Linux with `systemctl --user`** for the strongest SSH persistence via
  systemd linger. macOS and non-systemd hosts use zellij's background server.

## Usage

Start Codex. A missing pane count selects one pane:

```bash
maxcodex          # 1 pane
maxcodex 1        # 1 pane
maxcodex 2        # 2 panes
maxcodex work     # named workspace
maxcodex oss 2    # named workspace with 2 panes
maxcodex 3 --yolo # 3 panes with Codex approval/sandbox bypass
```

Start Claude:

```bash
maxclaude          # one throwaway pane
maxclaude work     # persistent named workspace with one pane
maxclaude work 2   # persistent named workspace with two panes
maxclaude 2        # persistent numbered workspace with two panes
maxagent claude 2 # explicit provider form
```

The legacy `maxclaude` command matches the live launcher. Its panes use Claude
Code's bypass mode. Use `maxagent claude ...` when you need the generated
provider profile and per-session `--safe` or `--yolo` selection.

Manage sessions:

```bash
maxagent ls
maxagent attach 1
maxagent attach codex-work
maxagent close 1
maxagent close all
maxagent prune
```

Inside zellij:

- **Detach**: `Ctrl-o` then `d`
- **Move between panes**: `Alt`+arrow keys
- **Move without Alt/Option**: `Ctrl-o` then `h`/`j`/`k`/`l`
- **Close the whole window**: `Ctrl-q`

Re-running the same name/number re-attaches.

Numbered `maxclaude` sessions are named `max1`..`max4` (not `claude1`..`claude4`),
and numbered `maxcodex` sessions are `codex1`..`codex4`. Use the number shown by
`maxagent ls`, or the full name, to attach or close them.

`codex` and `claude` are provider selectors, so they cannot be used as workspace
names (`maxagent codex` opens Codex, it does not open a workspace named "codex").
Pick another name, e.g. `maxagent codex work`.

## Providers And Models

`maxagent` chooses which CLI to launch. It does not choose the model itself.

```bash
maxcodex 1          # launches Codex
maxclaude 1         # launches Claude Code
maxagent codex 2    # explicit Codex provider
maxagent claude 2   # explicit Claude provider
```

Codex model selection comes from Codex itself: your Codex defaults, your Codex
config, or flags passed through the generated profile:

```bash
~/.config/maxagent/profiles/codex.sh
```

For example, add a model flag to the final `exec` line:

```bash
exec codex --cd "$HOME/Projects" --model gpt-5.4 "$@"
```

Or use a Codex config profile:

```bash
exec codex --cd "$HOME/Projects" --profile my-profile "$@"
```

If the installer generated an absolute Codex path or an `export PATH=...` line
for nvm, keep those parts and add flags after the `--cd` argument.

Claude panes started through `maxagent claude` use the generated profile. To
change their launch flags, edit:

```bash
~/.config/maxagent/profiles/claude.sh
```

Running panes keep the command they started with. Close and reopen a session
after changing a provider profile.

## Web Version

The optional web version gives one operator a browser interface for managing
Claude Code sessions on connected machines. Install its agent alongside the
core tools with:

```bash
MCW_HUB_URL=wss://hub.example.com/agent \
MCW_AGENT_SECRET='replace-with-the-hub-agent-secret' \
  ./install.sh --with-web-agent
```

The flag does not change a normal installation. Follow the configuration and
privacy guidance in [web/README.md](web/README.md) before starting the agent.

## Temporary Browser Reaper

The installer adds a user timer that can close abandoned headless Chrome
processes created with a temporary profile under `/tmp`. It only considers
browser process trees older than `MAXCLAUDE_BROWSER_MAX_HOURS`. The default is
`0`, which disables the reaper.

Set a positive value in `~/.config/maxagent/browser-reaper.env`, then restart
the timer:

```bash
# ~/.config/maxagent/browser-reaper.env
MAXCLAUDE_BROWSER_MAX_HOURS=36

systemctl --user restart maxclaude-browser-reaper.timer
```

Fractional hours are accepted for a short test. The reaper never closes a
browser with a persistent profile outside `/tmp`. Its actions are recorded by
the `maxclaude-browser-reaper.service` journal.

## Router Mode (maxrouter)

maxrouter turns one Claude session into a switchboard for many. You talk to a
single router conversation; it routes each message to a persistent, org-scoped
worker conversation (a **task**) and relays the answer back.

A task is a named Claude conversation with its own session id, working
directory, and org. It exists whether or not it is on screen:

- **headless** (the default): runs via `claude -p --resume` in the background,
  no terminal, no pane;
- **paned**: the same conversation promoted into a zellij session
  (`task-<name>`) that you can watch or type into directly.

`mxr open` and `mxr close` only change how you view a conversation; nothing is
started or lost either way.

```bash
maxrouter              # create or attach the router session ("router")
maxrouter status       # tasks + live sessions + router/web state
maxrouter web start    # web GUI on port 8787 (binds your tailnet address)
```

Talk to the router in plain language: "ask the work agents to check the deploy",
"any updates?", or "put the release task on a screen". The router only drives
`mxr` and relays worker replies.

`mxr` is the toolbox the router (and you, directly) use:

```bash
mxr new deploy-fix --org w --desc "fix the deploy"
mxr send deploy-fix "what broke?"   # dispatches, prints the worker's reply
mxr open deploy-fix                 # promote to a pane (task-deploy-fix)
mxr close deploy-fix                # demote to headless; conversation persists
mxr tasks                           # list tasks with mode/status/last activity
mxr log deploy                      # grep the master log
mxr archive deploy-fix
```

### Checking on workers

The registry `status` column ("active") only says a conversation exists: not
whether the worker is doing anything *right now*. These four commands derive
live truth from the zellij pane, the bound `claude` process (matched by the
task's session id), and the transcript file's mtime:

```bash
mxr health                # per-task verdict: WORKING / IDLE / STALLED / DEAD / NEW
mxr health --json         # same, machine-readable (for the router to act on)
mxr peek deploy-fix       # dump a paned worker's current screen, no attach
mxr peek deploy-fix -n 80 # last 80 lines; --raw keeps ANSI; --session S for any window
mxr watch deploy-fix      # live-refresh that pane (or a headless task's transcript)
mxr ps                    # every active task -> its claude PID / RSS / etime / zellij srv
```

`health` distinguishes *still working* from *stalled/dead* rather than trusting
the flag: a pane whose spinner is animating reads **WORKING** even mid-think;
one parked at the `❯` prompt reads **IDLE**; a pane frozen off-prompt with a
cold transcript reads **STALLED**; a `paned` task whose session or `claude`
process is gone reads **DEAD**. The footer compares live sessions with the
configured `MXR_SESSION_CAP` before opening more panes.

### Event bridge: replies push to the router, it never polls

Async replies used to sit in the outbox until the router happened to look. Now
`mxr-notifyd` (a `flock`-guarded `inotifywait` watcher on
`router/outbox/`, run as the `maxrouter-notify.service` user unit) reacts the
instant a reply lands and types a one-line `[worker-reply] worker 'X' finished…`
event into the router's pane, so the router relays immediately with zero timers.

- Only **async** sends (`mxr send --async`) arm it: they drop a `outbox/.notify/<sid>`
  marker, and the watcher pokes only for marked replies. Synchronous sends: where
  the router already has the reply inline: write no marker, so the router is
  never double-notified.
- The watcher is a single kernel-blocked process (near-zero CPU); the `flock`
  ensures only one runs even if started twice.
- `maxrouter notify start|stop|status` controls it; `mxr notify <task>`
  re-pushes a task's latest reply by hand if one was ever missed.

```bash
maxrouter notify status   # is the bridge up?
mxr send bigjob --async "run the full suite"   # fire-and-forget; router gets poked on completion
```

### Blocked-worker detection: a stuck worker can't hang silently

A paned worker's claude can drop into a modal that waits for a keypress (an
AskUserQuestion menu, a permission prompt, the folder-trust dialog). Nothing
writes to the outbox, so the reply bridge never fires and the worker hangs
invisibly. Two defenses:

1. **Workers are told not to block.** The worker system prompt (`preamble` in
   `mxr`, applied to headless via `--append-system-prompt` and to paned via the
   session env file's `MAXCLAUDE_APPEND_PROMPT`) instructs: *never open an
   interactive menu: write the question and numbered options as plain text and
   stop.* So a worker needing a decision posts it as a normal reply the router
   relays, and parks at its prompt (`mxr health` shows it **IDLE**).

2. **If one blocks anyway, it's surfaced in seconds.** `mxr-blockd`
   (`maxrouter-blockd.service`, `flock`-guarded) samples every paned worker's
   screen on a short interval. A pane is **BLOCKED** when it shows a modal
   signature (`❯ 1.`, `Enter to select`, a permission/trust footer) **and** the
   normal input affordance (`bypass permissions on`) / working spinner
   (`esc to interrupt`) are absent **and** the screen is static: so menu text
   in scrollback never false-triggers. On a block it pushes a `[worker-blocked]`
   event (with the prompt + options) into the router pane; the router relays the
   question to the operator, who answers with `mxr send <task> "1"` (or free
   text). `mxr health` also shows the task as **BLOCKED**.

```bash
maxrouter blockd status   # is the block watcher up?
mxr health                # BLOCKED rows are workers waiting on an operator decision
```

Task names are short kebab-case (`^[a-z0-9][a-z0-9-]{0,40}$`). Every send is
appended in both directions to `master-log.jsonl` in the config dir
(`~/.config/maxclaude`, overridable with `MAXROUTER_CONFIG_HOME`), so old
exchanges are one `mxr log` away.

The web GUI (`maxrouter web start`) is a single-file stdlib-Python dashboard
showing orgs, tasks, and the live log, with send from a browser or phone.
Workers run with `--dangerously-skip-permissions`, so treat the GUI endpoint
like a root shell: keep it tailnet-only, set `MAXROUTER_TOKEN`, and never
port-forward or reverse-proxy it to the public internet.

### Orgs

Orgs live in the config dir as `orgs.json` (seeded from `orgs.json.example` on
install). Each org gives its tasks a default working directory, aliases for
quick routing, and a color for the web GUI:

```json
{
  "orgs": [
    {"name": "Work", "aliases": ["w"], "workdir": "~", "color": "#7c5cff"},
    {"name": "Personal", "aliases": ["p", "me"], "workdir": "~", "color": "#ff7675"}
  ]
}
```

Orgs also scope plain `maxclaude` workspaces: a workspace name that matches an
org name or alias (case-insensitive) opens its panes in that org's workdir:

```bash
maxclaude w 2    # two panes, both starting in Work's configured directory
```

Non-org names behave exactly as before, and `maxclaude ls` shows an org tag
next to org-scoped workspaces.

### Runtime configuration

Private values stay outside this repository. Set these in the environment or
the named config file:

| setting | purpose |
|---|---|
| `MAXCLAUDE_WORKDIR` | default directory for legacy Claude panes |
| `MAXCLAUDE_ZELLIJ` | zellij executable path |
| `MAXROUTER_CONFIG_HOME` | router state and configuration directory |
| `MAXROUTER_DEFAULT_WORKDIR` | fallback task directory when old state has no workdir |
| `MAXROUTER_BIND` | web server bind address |
| `MAXROUTER_PORT` | web server port |
| `MAXROUTER_TOKEN` | optional web request token |
| `MXR_SESSION_CAP` | live-session capacity shown by `mxr health` |
| `MAXAGENT_USAGE_COMMAND_FILE` | file containing the private status-bar command |
| `MAXCLAUDE_RESTORE_FILE` | private tab-separated restore map |
| `CLAUDE_CONFIG_DIR` | Claude state directory used to locate transcripts |

The usage command file defaults to
`~/.config/maxagent/usage-command`. Its first line is executed by the status
bar. Leave the file absent to show no private usage source.

The restore map defaults to `~/.config/maxclaude/restore.tsv`. Each non-comment
line contains four tab-separated fields: workspace name, Claude session id,
workdir, and optional pane count. Run `maxclaude-restore` after creating it.

## How It Works

- `~/.local/bin/maxagent` owns zellij session management.
- `~/.local/bin/maxcodex` wraps maxagent for Codex.
- `~/.local/bin/maxclaude` carries the legacy live launcher behavior.
- `~/.config/maxagent/profiles/codex.sh` launches Codex.
- `~/.config/maxagent/profiles/claude.sh` launches Claude.
- `~/.config/maxagent/sessions/<name>.env` records each session's provider, pane
  count, and whether it was opened in `--yolo` mode.
- `~/.local/bin/maxagent-pane` runs inside each pane and dispatches to the
  session's provider profile.
- `~/.config/zellij/layouts/agent{1,2,3,4}.kdl` define the pane layouts.
- `~/.config/systemd/user/maxagent-named@.service` starts background sessions on
  systemd hosts. It has **no `[Install]` section** on purpose: sessions survive
  disconnects but never respawn on reboot.

Sessions do **not** survive a full reboot. They survive logging out or SSH
disconnects when systemd linger or zellij background persistence is available.

## Upgrading from maxclaude

The installer keeps the numbered and named maxclaude user units. Existing
sessions remain untouched during installation. Reopen them only when you want
the updated pane launcher.

## Uninstall

```bash
./uninstall.sh                          # stop sessions, remove maxagent's files
./uninstall.sh --remove-zellij          # also delete ~/.local/bin/zellij
./uninstall.sh --keep-legacy-maxclaude  # keep the maxclaude command + its config
```

## License

[MIT](LICENSE).
