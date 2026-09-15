# MVP-2 evidence — 2026-09-15

Checkout: `/workspace/harness`. No remotes. Did not touch herdr-desk.

## resume with no session (exit 1)

```
$ mv ~/.local/state/herdr-harness/state.json ~/.local/state/herdr-harness/state.json.bak.mvp2
$ harness resume
nothing to resume: no session id in state
state file: /home/box/.local/state/herdr-harness/state.json
run: harness start
exit=1
```

## start + status --json

```
$ harness start
ok
harness started at 2026-09-15T19:42:36.265Z
session: 94b807c6-d8fc-4a69-a2c4-ab51b4e03563
```

```
$ harness status --json
{
  "ok": true,
  "plugin": "harness",
  "version": "0.0.2",
  "started": true,
  "startedAt": "2026-09-15T19:42:36.265Z",
  "sessionId": "94b807c6-d8fc-4a69-a2c4-ab51b4e03563",
  "agent": "grok-build",
  "defaultAdapter": "grok-build",
  "configPath": "/workspace/harness/examples/minimal/.herdr-harness.json",
  "root": "/workspace/harness",
  "stateFile": "/home/box/.local/state/herdr-harness/state.json"
}
```

## resume + start --resume

```
$ harness resume
restored session
sessionId: 94b807c6-d8fc-4a69-a2c4-ab51b4e03563
startedAt: 2026-09-15T19:42:36.265Z
agent:     grok-build
Press Ctrl+G in the agent to restart and resume.
(Ctrl+G = restart + resume; this CLI path is harness resume)
```

```
$ harness start --resume
ok
harness started at 2026-09-15T19:42:36.265Z
session: 94b807c6-d8fc-4a69-a2c4-ab51b4e03563
resumed existing session
```

## upgrade (missing link → relink)

```
$ rm -f ~/.local/bin/harness
$ bun /workspace/harness/src/cli.ts upgrade
harness upgrade (local, no network)
checkout version: 0.0.2
installed:        0.0.2 @ /workspace/harness
link:             /home/box/.local/bin/harness -> (missing)
relinked /home/box/.local/bin/harness -> /workspace/harness/bin/harness
recorded version 0.0.2
Press Ctrl+G in the agent to restart and resume.
```

```
$ harness upgrade
harness upgrade (local, no network)
checkout version: 0.0.2
installed:        0.0.2 @ /workspace/harness
link:             /home/box/.local/bin/harness -> /workspace/harness/bin/harness
already up to date
Press Ctrl+G in the agent to restart and resume.
```

`git describe --tags --always` is unavailable here (`fatal: Not a valid object name HEAD`); version compare uses `package.json` + link realpath.

## adapters / soul

Example config `adapters.default` = `grok-build` appears as `defaultAdapter` in status JSON. Template: `templates/soul.md`.
