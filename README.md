# harness (Herdr plugin)

Persistent local agent harness. Separate from [herdr-desk](https://github.com/duyet/herdr-desk) (cron desk).

Plugin id: `harness` · version from `package.json` (0.0.6)

## Install / upgrade

```bash
chmod +x bin/harness
harness upgrade                          # links ~/.local/bin/harness -> this checkout
export PATH="$HOME/.local/bin:$PATH"
```

Herdr plugin link (required for the Ctrl+G `plugin_action`):

```bash
herdr --session harness plugin link /path/to/harness
```

### Verify

```bash
harness upgrade                                             # "already up to date" once linked
harness status --json                                       # ok:true + ctrlGHint
herdr --session harness plugin action list --plugin harness # shows "resume" (=> harness.resume)
cat examples/herdr-config-ctrl-g.toml                       # the Ctrl+G snippet to copy
```

## Commands

| Command | What it does |
| --- | --- |
| `harness start` | New session id |
| `harness start --resume` | Keep last session id |
| `harness status [--json]` | Status; JSON includes adapters + tasks + `ctrlGHint` |
| `harness resume` | Restore last session (CLI path; non-zero if none) |
| `harness upgrade` | Local relink of `~/.local/bin/harness` |
| `harness manager status` | Adapters, routes, tasks from `.herdr-harness.json` |
| `harness manager route <taskId>` | Resolve task → adapter JSON |
| `harness manager spawn <taskId>` | Dry-run `herdr worktree create` + `tab create` + agent start unless `--execute` and Herdr is usable; `--replace` cleans up first, `--cleanup` only cleans up |
| `harness manager cleanup <taskId>` | Dry-run cleanup; `--execute` closes the spawned tab then removes the worktree (`--force` forces removal) |
| `harness gateway start` | Background localhost HTTP + chat UI (`http://127.0.0.1:8787/`) |
| `harness gateway status` | Listening?, pid, bind, lastEvent, lastDelivery |
| `harness gateway stop` | Stop by pid file |
| `harness issues ingest --source sentry\|bugsink` | Mock GH issue draft from JSON stdin/`--file` (no GitHub API); `--execute` also runs a real `gh issue create` |
| `harness issues list` | Drafts under `~/.local/state/herdr-harness/issues/` |
| `harness pick` | Next work: mock issue drafts (severity-ordered) → named tasks → freeform queue |
| `harness summary` | On-demand markdown report (`--json` ok). **No cron.** `--deliver`/`--write` also writes `last-summary.md`/`.json` + `last-delivery.json` under the state dir |

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

### Manual verification (TUI — not automated)

The real keybind fires inside the Herdr TUI, which this repo cannot drive. Check by hand:

1. `herdr --session harness plugin action list --plugin harness` lists `resume`.
2. `~/.config/herdr/config.toml` contains the snippet above (copy of [`examples/herdr-config-ctrl-g.toml`](./examples/herdr-config-ctrl-g.toml)).
3. `herdr server reload-config` (or restart the server) so the keybind loads.
4. Focus an agent tab and press **Ctrl+G** — the harness session restarts and resumes.
5. `harness status --json` still shows `ok: true` with the resumed `sessionId`.

`harness status --json` echoes a `ctrlGHint` (`action`, `exampleConfig`) for scripted checks; `harness upgrade` prints the snippet path too.

## Per-repo config

Walk up from cwd for `.herdr-harness.json`, else `examples/minimal/.herdr-harness.json`.

- `adapters.routes` — grok-build, claude, anyr, codex, opencode. Route `kind` values that are Herdr agent kinds (e.g. `grok`, `claude`, `codex`, `opencode`) spawn via `herdr agent start --kind`; anything else (e.g. `anyr`) runs as a shell command in the new pane via `herdr pane run` (`kind` + `via` + `--model`/`flags`).
- `tasks` — id + adapter + optional worktree stub
- `soul` — [`templates/soul.md`](./templates/soul.md)
- `playbooks` — includes `desk:sentry-issues` (Sentry/Bugsink → mock GH issues)

Executed spawns persist minimal metadata (taskId → worktree path, workspace/tab/pane ids, agent name) in `~/.local/state/herdr-harness/spawns.json` for cleanup/replace. A task with a recorded spawn refuses a second `--execute`; pass `--replace` (cleanup then respawn) or `harness manager cleanup <taskId> --execute` first.

## Mock issues + pick/summary (on-demand)

Playbook **`desk:sentry-issues`**. Ingest writes a local mock draft and never calls GitHub — **mock is the default**. Passing `--execute` additionally runs `gh issue create` (title/body/labels derived from the draft, minus the `mock` label) using the repo `gh` detects from your cwd; on success the draft is rewritten with `status: "github-created"` plus `githubIssueUrl`/`githubIssueNumber`. Any `gh` failure (missing binary, not authed, non-zero exit) exits 1 and keeps the mock draft on disk. The gateway ingress stays mock-only.

```bash
echo '{"event_id":"abc","project":"harness","message":"TypeError: boom","culprit":"src/cli.ts","level":"error"}' \
  | harness issues ingest --source sentry            # mock draft, no gh
harness issues ingest --source bugsink --file event.json --execute   # real gh issue create
harness issues list
harness pick --json
harness summary
```

Gateway (restart after upgrade so new routes load): `POST /ingress/sentry` and `POST /ingress/bugsink`.

**Pick rules** (also exposed as `rules` in `harness pick --json`):

1. Issue drafts first, then config `tasks`, then freeform ingress.
2. Within issues: only `status: "mock-draft"` is pickable work — `github-created` drafts are never re-picked (if only created drafts remain, the issue tier is skipped entirely).
3. Higher severity `level` (from labels or `raw.level`) wins: `fatal > error > warning > info > other`.
4. Newer `createdAt` breaks severity ties.
5. Within tasks: rotate by list order after `lastPicked`; on a cold start (no prior task pick), tasks with a `worktree` stub are preferred before tasks without.
6. Freeform: the most recent freeform ingress event wins.

**Summary is CLI-only — no scheduler.** `harness summary --deliver` (alias `--write`) is the human-delivery stub: it writes the report to `~/.local/state/herdr-harness/last-summary.md` plus a `last-summary.json` sidecar, and records a `lastDelivery` blob in `last-delivery.json` that `harness gateway status --json`, `GET /status` and `harness summary` surface. Stub-mode `POST /chat` replies pick the last summary up when asked — body `"pickup": true`, a `?pickup=true` query flag, or the literal text `/summary` — by appending its excerpt and returning it as `lastSummary` (`null` when nothing was delivered). Executed `/chat` replies are never amended.

## Gateway / chat ingress (stub, opt-in execute)

Local HTTP only. **Never talks to real Matrix or Telegram APIs.** Tokens are unused placeholders.

A newly started gateway uses the launching cwd to discover repo config (walking upward). Starting again while it is already running does not switch repositories; run `harness gateway stop`, then restart from the desired repo.

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

`POST /chat` replies are stubs by default (`mode: "stub"` — no subprocess, no LLM). Opt in per request with `"execute": true` or globally with `HARNESS_CHAT_EXECUTE=1`: the gateway spawns the resolved route's CLI locally — route `kind` as the binary, then `via`/`--model`/`flags`, plus best-effort non-interactive args for known kinds (`claude -p`, `codex exec`, `gemini -p`, `grok -p`, `opencode run`) — with the chat text as the final argument and a hard timeout (default 10s, `HARNESS_CHAT_TIMEOUT_MS`, clamped 100–60000). On a clean exit 0 the reply is the adapter's stdout with `mode: "executed"`; on any failure (missing binary, non-zero exit, timeout) the response is still **200** `ok:true` with `mode: "stub"`, the stub `reply`, and an `executeError` field — `/chat` never hangs or 500s on adapter problems. Responses also carry top-level `adapterId` and an `execute` detail object (`command`, `status`, `timedOut`, `durationMs`) when an invoke was attempted. Matrix/Telegram ingress stays stub-only.

All five POST routes (`/chat` and `/ingress/matrix`, `/ingress/telegram`, `/ingress/sentry`, `/ingress/bugsink`) return **400** with `{ "ok": false, "error": "..." }` for invalid input: `invalid JSON` for malformed JSON or an empty body; `expected JSON object` for top-level null, arrays or scalars; `invalid payload shape` for non-object Matrix `content` or Telegram `message`, `chat` or `from` containers. Optional containers may be absent or null; Telegram checks `chat` and `from` on the selected message (nested `message`, or the top-level fallback). Empty objects and extra fields remain accepted; this is not full provider-schema validation. Rejected input does not write state. Success statuses remain **200** for `/chat` and **202** for the four ingress routes; GET and unknown-route behavior is unchanged.

### Env

| Var | Used now | Later |
| --- | --- | --- |
| `HARNESS_GATEWAY_HOST` | bind host (default `127.0.0.1`) | |
| `HARNESS_GATEWAY_PORT` | bind port (default `8787`) | |
| `HARNESS_CHAT_EXECUTE` | `1`/`true`/`yes`/`on` makes `/chat` run the adapter CLI | |
| `HARNESS_CHAT_TIMEOUT_MS` | `/chat` adapter timeout (default `10000`, clamped 100–60000) | |
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
- `tests/ctrl-g.test.ts` pins the Ctrl+G example snippet, the `harness.resume` plugin action id, and the `ctrlGHint` fields in `status --json`/`upgrade`.
- Each test runs the CLI in an isolated subprocess fixture under `dist/.test-tmp/` (own `HOME`, cwd and `TMPDIR`); nothing touches the real home or state directories.
- There are no lint or typecheck gates in this repo, and `bun test` does not typecheck.

## Not in this MVP

Fleet metrics, live Matrix/Telegram, cron. Real GitHub issue create is opt-in only (`issues ingest --execute`); the gateway never calls GitHub.

Explicitly deferred ([issue #1](https://github.com/duyet/harness/issues/1)):

- **release-please / release automation** — no RP config in this repo; revisit once a release story is approved.
- **Automated Ctrl+G verification** — the keybind runs inside the Herdr TUI; use the manual checklist above.
