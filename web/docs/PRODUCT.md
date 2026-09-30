# Product architecture

Maxclaude web is a browser interface for real maxclaude sessions. It has two parts.

- The hub serves the browser application, authenticates the single operator, stores the folder tree and transfer history in SQLite, and routes authenticated terminal traffic.
- The agent runs on the session host. It maintains an outbound tunnel to the hub, starts and inspects real sessions, proxies the local zellij web service, handles transfers, and reports Claude Code activity.

The browser connects only to the hub. The browser never receives zellij credentials. The hub never opens a connection back to the agent.

## Session model

A folder is stored only in the hub database. A session leaf names a real zellij and maxclaude session. The agent lists live sessions, and a live session with no leaf appears in Unfiled.

Creating a session requests the configured maxclaude launch flow. A session can optionally resume a Claude Code conversation when the corresponding local transcript exists. The agent rejects an invalid session name, unavailable working directory, missing transcript, or conflicting session name before it reports success.

Deleting a session stops and removes the live session through the configured local tools. Deleting a folder never silently deletes its session children. The browser asks how to handle children first.

The hub preserves each session's earliest observed creation time so moving or renaming a session does not make it appear new. Recent sessions are sorted by the latest real activity event. A browser visit does not affect the order.

## Activity and status

The optional status helper receives Claude Code hook events. It writes an atomic local record per pane. The agent checks those records against live Claude Code processes and reports a single session state.

| State | Meaning |
| --- | --- |
| Busy | At least one live pane reported prompt or tool activity. |
| Background | A matching live task process descends from the pane's current Claude Code process. |
| Idle | A live Claude Code process exists and no pane is busy. |
| Absent | No Claude Code process exists in the session. |
| Unknown | A live process has no current valid hook record. |

Busy uses a blinking green light. Background work uses a slower green pulse. Both lights become solid green when reduced motion is requested.

The helper records prompt submission, work before and after each tool, completion, and notifications. It must not affect Claude Code if status reporting fails. It exits successfully after handling an event. The hook installer merges the web hooks with existing hook arrays and keeps unrelated settings intact.

Recent uses each session's latest hook event. A unique current transcript can contribute its latest user or assistant message. Shared transcripts cannot transfer activity between sessions. Background state requires live process evidence and clears after that process exits. The server and browser use the same timestamp and session-name tie breaker, so live sorting and reload sorting agree.

## Terminal access

The agent runs zellij's web service locally and obtains its credentials locally. The hub proxies terminal HTTP and WebSocket traffic through the authenticated agent tunnel. Every browser terminal request still requires a valid hub cookie.

The application reserves names that conflict with its routes and static assets. The agent refuses a terminal socket for a session that no longer exists so an old browser tab cannot recreate a deleted session.

The browser may retain a limited set of hidden terminal connections. These warm terminals continue to receive output while hidden and are made visible without opening a new terminal connection.

## Transfers

Uploads use resumable browser requests. The hub sends tunnel chunks only after the agent acknowledges the preceding chunk. The agent validates session names and relative paths, writes the file before acknowledgement, and atomically finalizes the completed file.

The agent can stream a requested file, or package a requested directory as a zip stream. Downloads and uploads appear in the session Files drawer. Transfer history stores the session name, path, size, direction, and completion time.

## Remote Control rename

New sessions launch with their Remote Control name set to the session name. A browser rename requests a Claude Code rename through the active terminal, waits for the requested name to be confirmed, then renames the zellij and maxclaude session resources. A failed confirmation stops the rename operation.

## Security boundaries

The hub accepts one agent tunnel at a time. The agent proves the shared secret with a challenge-response HMAC, so the secret itself is never sent in a tunnel message.

The hub uses an argon2id password hash, signed HttpOnly browser cookies, login failure throttling, and server-side session revocation. It does not serve terminal bytes to unauthenticated HTTP or WebSocket requests.

Use persistent storage for the hub database. It contains the folder tree, password hash, login sessions, cookie-signing material, and transfer history. It does not contain the agent's local zellij credential.
