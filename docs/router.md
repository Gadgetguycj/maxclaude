# maxrouter

maxrouter turns one Claude session into a switchboard for many. You talk to a single router conversation; it routes each message to a persistent, org-scoped worker conversation and relays the answer back.

## Concept: tasks are conversations, panes are views

The unit of work is a task: a named, persistent Claude conversation with its own session id, working directory, and org. A task exists whether or not it is on screen.

- Headless mode: the conversation runs via `claude -p --resume` in the background. No terminal, no pane. This is the default.
- Paned mode: the same conversation is promoted into a zellij session (`task-<name>`) so you can watch it or type into it directly.

Opening a pane does not start anything new and closing a pane does not lose anything. `mxr open` and `mxr close` just change how you view a conversation that lives on disk either way. Full history stays in Claude's own session storage; a master log of everything routed lives in the config dir.

## Using maxrouter

```
maxrouter              # create or attach the router session (zellij session "router")
maxrouter status       # same as mxr status
maxrouter web start    # start the web GUI
maxrouter web stop     # stop it
maxrouter web status   # is it running
```

`maxrouter` drops you into a plain Claude session whose CLAUDE.md makes it behave as a pure dispatcher. Talk to it in plain language:

- "ask the work agents to check the deploy" creates or reuses a task in the Work org and relays your message.
- "any updates?" summarizes recent activity from the log.
- "put the release task on a screen" promotes it to a pane.
- "we're done with the cleanup task" archives it.

The router never does work itself. It only runs `mxr` commands and relays.

## mxr commands

`mxr` is the toolbox the router (and you, directly) use:

```
mxr orgs [--json]                 list configured orgs
mxr tasks [--json] [--org X]      list tasks with mode/status/last activity
mxr new <name> --org <org> --desc "..." [--workdir DIR]
mxr send <name> <message...>      dispatch a message, print the reply
    --async                       fire and forget; reply lands in outbox + log
    --timeout N                   reply wait in seconds (default 300)
mxr open <name>                   promote to a pane (zellij session task-<name>)
mxr close <name>                  demote to headless; conversation persists
mxr archive <name>
mxr log [-n N] [pattern]          tail or grep the master log
mxr status [--json]               tasks + live sessions + router/web state
mxr health [--json]               worker liveness and configured session cap
mxr peek <name> [-n N]            dump a paned worker screen without attaching
mxr watch <name>                  follow a pane or headless transcript
mxr ps [--json]                   worker process census
mxr notify <name>                 push a saved reply to the router again
```

Task names are short kebab-case (`^[a-z0-9][a-z0-9-]{0,40}$`). Every send is appended to `master-log.jsonl` in both directions, so `mxr log deploy` finds old exchanges without scrolling any terminal.

## orgs.json

Orgs live in the config dir (default `~/.config/maxclaude/orgs.json`, overridable with `MAXROUTER_CONFIG_HOME`). Each org gives tasks a default working directory, some aliases for quick routing, and a color for the web GUI:

```json
{
  "orgs": [
    {"name": "Work", "aliases": ["w", "work"], "workdir": "~", "color": "#7c5cff"},
    {"name": "Personal", "aliases": ["p", "me"], "workdir": "~", "color": "#ff7675"}
  ]
}
```

Copy `orgs.json.example` to get started. Adding an org is just adding an entry; the router picks it up on the next `mxr orgs`.

Old task state without a workdir uses `MAXROUTER_DEFAULT_WORKDIR`, which defaults
to the current user's home directory. `MXR_SESSION_CAP` controls the capacity
shown by `mxr health`.

## Web GUI

`maxrouter web start` runs a small stdlib-Python server that shows orgs, tasks,
and the live log. It accepts messages from a browser or phone. It automatically
uses a tailnet address when available and otherwise binds to loopback. Set
`MAXROUTER_BIND` and `MAXROUTER_PORT` to choose the listener. Set
`MAXROUTER_TOKEN` to require a token on every request.

## Security note

Workers run with `--dangerously-skip-permissions`: they can run any command in their working directory without asking. The web GUI can drive those workers. Treat the GUI endpoint like a root shell: keep it tailnet-only, set `MAXROUTER_TOKEN`, and never port-forward or reverse-proxy it to the public internet.
