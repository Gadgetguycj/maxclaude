# maxagent

Run **1-4 Codex or Claude panes in one terminal** with persistent zellij
sessions. This is useful on a Linux dev server: start multiple agent panes,
detach, close SSH, reconnect later, and attach to the same running workspace.

```bash
maxcodex          # 2x2 grid of 4 Codex panes
maxcodex 2        # two Codex panes
maxcodex work     # named Codex workspace
maxclaude         # Claude compatibility command
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
- writes provider profiles under `~/.config/maxagent/profiles`;
- installs the `agent{1,2,3,4}` zellij layouts;
- installs per-user systemd services on Linux when available;
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
maxclaude 2 --yolo
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

Start Codex:

```bash
maxcodex          # 4 panes
maxcodex 1        # 1 pane
maxcodex 2        # 2 panes
maxcodex work     # named workspace
maxcodex oss 2    # named workspace with 2 panes
maxcodex 3 --yolo # 3 panes with Codex approval/sandbox bypass
```

Start Claude:

```bash
maxclaude         # legacy Claude command
maxagent claude 2 # explicit provider form
maxclaude 2 --yolo # Claude with --dangerously-skip-permissions
```

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
for nvm, keep those parts and add flags after the `--cd` argument:

```bash
export PATH='/root/.nvm/versions/node/v24.16.0/bin':$PATH
exec '/root/.nvm/versions/node/v24.16.0/bin/codex' --cd '/root/Projects' --model gpt-5.4 "$@"
```

Claude panes work the same way: `maxclaude` launches `claude`, and Claude Code
uses its own defaults/configuration. To change Claude launch flags, edit:

```bash
~/.config/maxagent/profiles/claude.sh
```

Running panes keep the command they started with. Close and reopen a session
after changing a provider profile.

## How It Works

- `~/.local/bin/maxagent` owns zellij session management.
- `~/.local/bin/maxcodex` and `~/.local/bin/maxclaude` are provider wrappers.
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

If you previously installed the Claude-only `maxclaude` and have sessions still
running, run `maxclaude close all` once (or just reboot) after re-installing, so
the old per-session systemd units are replaced by the new `maxagent-named@`
units. Your `maxclaude` command keeps working and still opens Claude panes.

## Uninstall

```bash
./uninstall.sh                          # stop sessions, remove maxagent's files
./uninstall.sh --remove-zellij          # also delete ~/.local/bin/zellij
./uninstall.sh --keep-legacy-maxclaude  # keep the maxclaude command + its config
```

## License

[MIT](LICENSE).
