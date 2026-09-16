# harness (Herdr plugin)

Persistent local agent harness. Separate from [herdr-desk](https://github.com/duyet/herdr-desk) (cron desk).

Plugin id: `harness` · version from `package.json` (0.0.6)

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
| `harness gateway start` | Background localhost HTTP + chat UI (`http://127.0.0.1:8787/`) |
| `harness gateway status` | Listening?, pid, bind, lastEvent |
| `harness gateway stop` | Stop by pid file |
| `harness issues ingest --source sentry\|bugsink` | Mock GH issue draft from JSON stdin/`--file` (no GitHub API) |
| `harness issues list` | Drafts under `~/.local/state/herdr-harness/issues/` |
| `harness pick` | Next work: mock issues → named tasks (list order) → freeform queue |
| `harness summary` | On-demand markdown report (`--json` ok). **No cron.** |

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
- `playbooks` — includes `desk:sentry-issues` (Sentry/Bugsink → mock GH issues)

## Mock issues + pick/summary (on-demand)

Playbook **`desk:sentry-issues`**. Ingest never calls GitHub.

```bash
echo '{"event_id":"abc","project":"harness","message":"TypeError: boom","culprit":"src/cli.ts","level":"error"}' \
  | harness issues ingest --source sentry
harness issues ingest --source bugsink --file event.json
harness issues list
harness pick --json
harness summary
```

Gateway (restart after upgrade so new routes load): `POST /ingress/sentry` and `POST /ingress/bugsink`.

**Pick order:** mock issue drafts, then config `tasks` in list order (rotates after last pick), then freeform ingress. **Summary is CLI-only — no scheduler.**

## Gateway / chat ingress (stub)

Local HTTP only. **Never talks to real Matrix or Telegram APIs.** Tokens are unused placeholders.

```bash
harness gateway start
# open http://127.0.0.1:8787/  (HTML chat; /chat same)
curl -sS http://127.0.0.1:8787/health
curl -sS -X POST http://127.0.0.1:8787/chat \
  -H 'content-type: application/json' \
  -d '{"text":"task: mvp-review"}'
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

## Persistent Herdr host / VM install

This is **not** a new hypervisor. Install on an existing Herdr host, VM, or box.

```bash
# 1. CLI on PATH
chmod +x /path/to/harness/bin/harness
ln -sfn /path/to/harness/bin/harness ~/.local/bin/harness
export PATH="$HOME/.local/bin:$PATH"
harness upgrade    # local relink if checkout moved/version bumped

# 2. Herdr plugin (needed for Ctrl+G plugin_action)
herdr --session harness plugin link /path/to/harness

# 3. Ctrl+G in ~/.config/herdr/config.toml
# [[keys.command]]
# key = "ctrl+g"
# type = "plugin_action"
# command = "harness.resume"
# description = "restart + resume harness session"
herdr --session harness server reload-config

# 4. State lives here (sessions, gateway pid, mock issues, lastEvent)
# ~/.local/state/herdr-harness

# 5. Chat UI + ingress
harness gateway start
# open http://127.0.0.1:8787/   or  /chat
# GET /health remains JSON
```

After an in-place upgrade, **Press Ctrl+G in the agent to restart and resume.** Restart the gateway process so new HTTP routes load.

## Verification

Tests run on [Bun](https://bun.sh) with its built-in runner — no Herdr server or gateway needed:

```bash
bun run test
```

- `tests/baseline.test.ts` covers session persistence, routing, issue normalization and pick rotation through `src/cli.ts`.
- Each test runs the CLI in an isolated subprocess fixture under `dist/.test-tmp/` (own `HOME`, cwd and `TMPDIR`); nothing touches the real home or state directories.
- There are no lint or typecheck gates in this repo, and `bun test` does not typecheck.

## Not in this MVP

Fleet metrics, release-please, full child-agent spawn, live Matrix/Telegram, GitHub issue create, cron.
