# harness (Herdr plugin)

Persistent local agent harness. Separate from [herdr-desk](https://github.com/duyet/herdr-desk) (cron desk).

Plugin id: `harness` · version from `package.json` (0.0.3)

## Local install / link

```bash
chmod +x bin/harness
harness upgrade
export PATH="$HOME/.local/bin:$PATH"
```

Herdr plugin (required for Ctrl+G `plugin_action`):

```bash
herdr --session harness plugin link /workspace/harness
herdr --session harness plugin action list --plugin harness
```

## Commands

| Command | What it does |
| --- | --- |
| `harness start` | New session id |
| `harness start --resume` | Keep last session id |
| `harness status [--json]` | Status; JSON includes adapters + tasks |
| `harness resume` | Restore last session (CLI path; non-zero if none) |
| `harness upgrade` | Local relink of `~/.local/bin/harness` |
| `harness manager status` | Adapters, routes, tasks from `.herdr-harness.json` |
| `harness manager route <taskId>` | Resolve task → adapter JSON |
| `harness manager spawn <taskId>` | Dry-run `herdr worktree create` unless `--execute` and Herdr is usable |

## Ctrl+G (user config, not the plugin)

**Plugins cannot declare keybindings.** Bind in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "ctrl+g"
type = "plugin_action"
command = "harness.resume"
description = "restart + resume harness session"
```

Snippet: [`examples/herdr-config-ctrl-g.toml`](./examples/herdr-config-ctrl-g.toml).

Primary path is still `harness resume`. After an in-place upgrade, a running agent still has the old process in memory: **Press Ctrl+G in the agent to restart and resume.**

Then: `herdr server reload-config` if a server is already running.

## Per-repo config

Walk up from cwd for `.herdr-harness.json`, else `examples/minimal/.herdr-harness.json`.

- `adapters.routes` — grok-build, claude, anyr, codex, opencode
- `tasks` — id + adapter + optional worktree stub
- `soul` — [`templates/soul.md`](./templates/soul.md)

## Not in this MVP

Fleet metrics, release-please, full child-agent spawn, gateway/chat.
