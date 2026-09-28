# Hub and agent protocol

The web hub and agent use one outbound WebSocket tunnel. The agent initiates the connection. Text frames carry JSON control messages. Binary frames carry proxied HTTP bodies, terminal WebSocket data, and file streams.

This document describes protocol version 1. Incompatible changes require a new version.

## Authentication

The hub sends a random nonce in a `hello` message. The agent responds with an `auth` message that carries an HMAC-SHA256 proof over that nonce using the shared secret. The hub compares the proof and sends `auth.ok` or closes the connection.

The secret does not travel in a protocol message. The hub permits one authenticated agent. A replacement connection is refused while an agent is connected.

## Control messages

Control frames are JSON objects with a `t` field.

```json
{"t":"req","id":"r-17","method":"sessions.list","params":{}}
```

The hub sends `req` and the agent returns exactly one `res` with the same id. A success has `ok: true` and `result`. A failure has `ok: false` and an error object with a machine-readable code and one-line message.

The agent also sends `event` messages for availability and status changes. The hub treats events as timely updates and polls the session list for current session state.

Supported control methods include agent information, session listing, creation, rename, deletion, transcript listing, path checks, file transfer setup, and HTTP or WebSocket proxy setup. Inputs are validated at the agent before local actions occur.

## Binary framing

Each binary frame starts with a six-byte header.

| Bytes | Field |
| --- | --- |
| `0` | Frame kind. |
| `1` through `4` | Unsigned big-endian channel id. |
| `5` | Flags. |
| `6` onward | Payload. |

Frame kinds are `0x01` for proxied terminal WebSocket data, `0x02` for proxied HTTP body data, `0x03` for upload data, and `0x04` for download data. Channel id zero is invalid.

WebSocket frames preserve their text or binary type. HTTP and file frames use a final flag to mark the last chunk. File streams permit one unacknowledged chunk at a time. This keeps transfer memory bounded and applies backpressure across the tunnel.

## Tunnel lifecycle

Either peer may send an application `ping` and receive a matching `pong`. The agent reconnects with backoff after a lost tunnel. The hub marks session information unavailable while no agent is connected. It does not invent session data.

Malformed control data, an unsupported version, an invalid authentication proof, or a handshake timeout closes the tunnel. In-flight requests fail when the connection drops and are not replayed automatically.

## Browser traffic

The hub terminates browser authentication before forwarding terminal HTTP or WebSocket requests. The agent injects local zellij credentials while proxying them. The browser sees neither the credential nor a direct local service address.
