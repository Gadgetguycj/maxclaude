# maxclaude web agent

The agent runs on the machine that hosts Claude Code and zellij. It makes an outbound authenticated connection to the hub.

Set `MCW_HUB_URL` and `MCW_AGENT_SECRET`, then run `./install.sh`. The installer writes the secret with restrictive permissions and never prints it.

Run `./install.sh --install-hooks` to merge status hooks into Claude Code settings. The hook installer retains existing settings and existing hooks.

The defaults use the current user's home and configuration directories. The installer records runtime settings in `agent.env`, installs a user service, and supports these variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCW_HUB_URL` | `wss://hub.example.com/agent` | Hub agent WebSocket URL. The installer requires an explicit value. |
| `MCW_AGENT_SECRET` | none | Installer input for the shared agent secret. It is written to the secret file and is not stored in `agent.env`. |
| `MCW_STATE_DIR` | `$XDG_CONFIG_HOME/maxclaude-web` | Agent state and generated configuration directory. |
| `MCW_SECRET_FILE` | `$MCW_STATE_DIR/tunnel.secret` | File containing the shared agent secret. |
| `MCW_TOKEN_FILE` | `$MCW_STATE_DIR/zellij-token.json` | Cached zellij web token file. |
| `MCW_STATUS_DIR` | `$MCW_STATE_DIR/session-status` | Status records written by the Claude Code hooks. |
| `MCW_FILES_ROOT` | `$MCW_STATE_DIR/files` | File-transfer storage root. |
| `MCW_PROJECTS_DIR` | `$CLAUDE_CONFIG_DIR/projects` | Claude Code project transcript tree. |
| `MCW_SESSION_ENV_DIR` | `$CLAUDE_CONFIG_DIR/session-env` | maxclaude session environment records. |
| `MCW_ZELLIJ_BIN` | `$HOME/.local/bin/zellij` | zellij executable. |
| `MCW_ZELLIJ_CONFIG` | `$XDG_CONFIG_HOME/zellij/config.kdl` | zellij configuration file. |
| `MCW_WEB_HOST` | `127.0.0.1` | Local zellij web listen address. |
| `MCW_WEB_PORT` | `8082` | Local zellij web listen port. |
| `MCW_MAXCLAUDE_CFG` | `$XDG_CONFIG_HOME/maxclaude` | maxclaude session metadata directory. |
| `MCW_TRANSCRIPT_DIR` | `$CLAUDE_CONFIG_DIR/projects` | Transcript search root. |
| `MCW_DEFAULT_WORKDIR` | `$HOME` | Working directory for sessions created in the browser. |
| `MCW_AGENT_NAME` | current hostname | Agent name shown to the hub. |
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | Claude Code configuration directory. |
| `XDG_CONFIG_HOME` | `$HOME/.config` | Base user configuration directory. |
| `XDG_RUNTIME_DIR` | `/run/user/<uid>` | Per-user runtime directory. |
| `MCW_BIN_DIR` | `$HOME/.local/bin` | Installer destination for the status helper. |
| `MCW_INSTALL_ROOT` | `$HOME/.local/share/maxclaude/web/agent` | Installer destination for the agent code. |

The installer requires a working user systemd instance. Use `--no-start` to install and enable the service without restarting it. Re-running the installer updates its managed environment file and preserves Claude Code settings and unrelated hooks.
