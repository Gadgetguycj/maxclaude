# Maxclaude web version

The web version adds a browser control plane to maxclaude. The hub stores the folder tree and browser login state. An agent runs beside the local maxclaude and zellij installation, opens an outbound connection to the hub, and provides access to real sessions.

The hub has one operator account. It uses an argon2id password hash and an authenticated browser cookie. The agent and hub authenticate each other with a separate shared secret. Keep both values private.

This feature needs a host that can run the Claude Code CLI, maxclaude, and zellij. The hub may run on the same host or elsewhere. The agent opens the network connection, so the session host needs no inbound port for the hub.

## Quick start

Install maxclaude first. Build and run the hub from this directory.

```bash
cd web/hub
npm ci
read -rsp 'Operator password: ' OPERATOR_PASSWORD
echo
export OPERATOR_PASSWORD
export AGENT_SECRET="$(openssl rand -hex 32)"
export DATA_DIR="$HOME/.local/share/maxclaude-web"
export COOKIE_SECURE=false
npm start
```

The hub listens on port `8080` by default. For a local installation, keep it on loopback and point the agent at it:

```bash
cd ../..
MCW_HUB_URL=ws://127.0.0.1:8080/agent \
MCW_AGENT_SECRET="$AGENT_SECRET" \
  ./install.sh --with-web-agent
```

The optional installer installs the web agent on the machine that runs Claude Code. It configures the hub URL and shared secret, enables zellij web sharing for new sessions, and installs the status hooks. It preserves existing Claude Code hooks and settings. It does not replace the settings file.

Open `http://127.0.0.1:8080`, sign in with `OPERATOR_PASSWORD`, then create or select a session. Use HTTPS and `wss://` when the hub is not local.

Do not place passwords or shared secrets in shell history, source control, or an image. In a service deployment, supply them through the service environment or a secret manager. The installer never prints a generated secret.

## Configuration

The hub reads its settings from environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Hub listen address. Set this to the container interface when running in a container. |
| `PORT` | `8080` | Hub listen port. |
| `DATA_DIR` | `/data` | Directory for the hub SQLite database. Use persistent storage. |
| `OPERATOR_PASSWORD` | none | Password used to seed the single operator login on first boot. |
| `AGENT_SECRET` | none | Shared secret used by the agent tunnel. |
| `COOKIE_SECURE` | `true` | Set to `false` only for a local plain-HTTP setup. |
| `SESSION_TTL_DAYS` | `30` | Browser login lifetime. |
| `LOGIN_WINDOW_S` | `900` | Login failure window. |
| `LOGIN_MAX_FAILURES` | `8` | Failed logins before temporary lockout. |
| `LOCKOUT_BASE_S` | `900` | Initial lockout duration. |
| `LOCKOUT_MAX_S` | `21600` | Maximum lockout duration. |
| `AGENT_PING_MS` | `20000` | Hub-to-agent keepalive interval. |
| `AGENT_RPC_TIMEOUT_MS` | `20000` | Hub timeout for an agent operation. |
| `CLIENT_PING_MS` | `25000` | Browser terminal keepalive interval. |
| `TRUST_PROXY` | `false` | Express proxy trust rule. Set a hop count or named proxy range only when a trusted reverse proxy supplies client addresses. |

The agent configuration uses `MCW_HUB_URL` and its configured secret file. [The agent README](agent/README.md) documents every local path and network setting. Give it the same secret as `AGENT_SECRET`.

## Using the web version

The sidebar is a nested folder tree. Folders are hub metadata. Session leaves represent real maxclaude sessions on the agent host. Sessions created outside the browser appear in Unfiled.

Status lights report the activity of real Claude Code panes. Green indicates busy, orange indicates idle, gray indicates no active Claude process, and an unknown state means the agent has not received a current activity record. The status hooks report prompts, tool activity, completion, and notifications.

Recent sessions lists sessions by their most recent completed response. Opening a terminal does not change that order. The setting can show 3, 5, 10, or 15 sessions, or turn the list off.

The browser keeps recently used terminal connections warm. Switching between warm sessions avoids reconnecting the terminal when capacity permits. One terminal is visible at a time.

Drag files or folders onto an open terminal to transfer them to that session. The agent writes the upload before acknowledging it. The completed paths are inserted at the terminal prompt without submitting a command. Terminal path links can download files, or download directories as zip archives. The Files drawer keeps transfer history for each session.

Remote Control names use the session name. Renaming a session in the web interface asks Claude Code to rename its Remote Control session and then updates the zellij and maxclaude session names. The rename reports an error if the running session cannot confirm the requested name.

## Keep the UI private

This UI can control local command-line agents. Put it behind an access boundary that you administer.

- Bind the published port to loopback when the browser runs on the same machine.
- Bind it to a private virtual-network interface when remote private access is required.
- For internet-facing HTTPS, place the hub behind an authentication proxy and restrict the proxy to intended users.
- Keep the agent endpoint protected by TLS when it crosses a network, and use a separate hostname or route policy if your proxy supports it.

The hub login is still required behind a proxy. The agent endpoint accepts the shared-secret handshake, not browser credentials.

## Deployment examples

[docker-compose.example.yml](deploy/docker-compose.example.yml) runs one hub on one machine and publishes only to loopback by default. [kubernetes.example.yaml](deploy/kubernetes.example.yaml) defines persistent storage, a named Secret reference, a Service, and generic Ingress routes. Adapt image names, hostnames, and storage settings for your environment.

Read [the top-level README](../README.md) for maxclaude installation and CLI usage. Read [Product architecture](docs/PRODUCT.md) and [the tunnel protocol](docs/PROTOCOL.md) for implementation details.
