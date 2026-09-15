# harness (Herdr plugin)

Persistent local agent harness. Separate from [herdr-desk](https://github.com/duyet/herdr-desk) (cron desk).

Plugin id: `harness` · version from `package.json` (0.0.4)

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
| `harness gateway start` | Background localhost HTTP ingress (default `127.0.0.1:8787`) |
| `harness gateway status` | Listening?, pid, bind, lastEvent |
| `harness gateway stop` | Stop by pid file |

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

## Gateway / chat ingress (stub)

Local HTTP only. **Never talks to real Matrix or Telegram APIs.** Tokens are unused placeholders.

```bash
harness gateway start
harness gateway status
curl -sS http://127.0.0.1:8787/health
curl -sS -D- -X POST http://127.0.0.1:8787/ingress/matrix \
  -H 'content-type: application/json' \
  -d '{"room_id":"!fake:localhost","sender":"@alice:localhost","content":{"body":"task: mvp-review please"},"taskId":"mvp-review"}'
curl -sS -X POST http://127.0.0.1:8787/ingress/telegram \
  -H 'content-type: application/json' \
  -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":1,"type":"private"},"from":{"id":1,"username":"bob"},"text":"/run docs","taskId":"docs"}}'
harness gateway stop
```

Ingress returns **202** and runs manager route in-process (no herdr spawn). Queue/last event: `~/.local/state/herdr-harness/last-ingress.json`.

### Env (stub)

| Var | Used now | Later |
| --- | --- | --- |
| `HARNESS_GATEWAY_HOST` | bind host (default `127.0.0.1`) | |
| `HARNESS_GATEWAY_PORT` | bind port (default `8787`) | |
| `HARNESS_MATRIX_TOKEN` | unused | Matrix client |
| `HARNESS_MATRIX_HOMESERVER` | unused | Matrix client |
| `HARNESS_TELEGRAM_BOT_TOKEN` | unused | Telegram bot |

## Not in this MVP

Fleet metrics, release-please, full child-agent spawn, live Matrix/Telegram.
