# MVP-3 evidence — 2026-09-15

Checkout `/workspace/harness` v0.0.3. Did not touch herdr-desk. No remotes.

## herdr plugin link

```
$ herdr --session harness plugin link /workspace/harness
{"id":"cli:plugin","result":{"plugin":{...,"plugin_id":"harness","plugin_root":"/workspace/harness","source":{"kind":"local"},"version":"0.0.3"},"type":"plugin_linked"}}
```

```
$ herdr --session harness plugin list
- harness (Harness) enabled [local:/workspace/harness]
- herdr-desk (Herdr Desk) enabled [github:duyet/herdr-desk@...]
```

```
$ herdr --session harness plugin action list --plugin harness
actions include action_id=resume command=["bin/harness","resume"] plugin_id=harness
also start, status, upgrade
```

## Ctrl+G config

Wrote `/home/box/.config/herdr/config.toml` (previous content was only `onboarding = false`):

```toml
onboarding = false

[[keys.command]]
key = "ctrl+g"
type = "plugin_action"
command = "harness.resume"
description = "restart + resume harness session"
```

```
$ herdr --session harness server reload-config
{"id":"cli:server:reload-config","result":{"diagnostics":[],"status":"applied","type":"config_reload"}}
```

**Bound:** yes. Plugin manifests cannot declare keys; user config + `plugin_action` `harness.resume`. Keypress itself was not exercised in this TUI session.

## CLI

### start --resume / status --json / resume / upgrade

`harness start --resume` → `ok` + session `05017eba-3425-4fec-90f2-682384a8791f`

`harness status --json` → `ok: true`, `version: 0.0.3`, adapters grok-build/claude/anyr/codex/opencode, four tasks, `defaultAdapter: grok-build`

`harness resume` → restored that session + Ctrl+G hint

`harness upgrade` → `already up to date` + Ctrl+G hint

### manager

`harness manager status` — lists adapters + tasks from `examples/minimal/.herdr-harness.json`

`harness manager route mvp-review` — `adapterId: grok-build`, `route.kind: grok`

`harness manager route docs` — `adapterId: claude`

`harness manager spawn mvp-review` — `mode: "dry-run"`, `intendedCommands` includes `herdr worktree create --branch harness/mvp-review --no-focus`. Herdr socket present; skipped execute by default.

`harness manager spawn no-such` — `ok: false`, exit 1, `error: unknown task: no-such` (not silent)

`harness manager spawn mvp-review --execute` — `mode: "executed"`, herdr returned status 1:

```
{"error":{"code":"worktree_create_failed","message":"fatal: invalid reference: HEAD"},"id":"cli:worktree:create"}
```

Expected here: this checkout has no git HEAD. Failure is reported in JSON, not swallowed.
