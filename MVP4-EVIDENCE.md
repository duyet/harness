# MVP-4 evidence — 2026-09-15

Local-only. No remotes/push. Did not touch herdr-desk. No gateway/chat.

## 1) First git commit (HEAD exists)

Local identity (no global user.name/email on box; did not invent Duyet):

```
git config --local user.name "harness local"
git config --local user.email "harness@local"
```

```
$ git rev-parse HEAD
5666612ed8a0ef7f21ea2db76ed879d7741afece

$ git log -1 --format='%H%n%s%n%an <%ae>'
5666612ed8a0ef7f21ea2db76ed879d7741afece
Initial MVP scaffold for Herdr harness plugin v0.0.3
harness local <harness@local>
```

Root commit included the v0.0.3 tree (plugin CLI, schema, examples, MVP1–3 evidence, soul template).

## 2) Live manager spawn --execute

```
$ cd /workspace/harness
$ harness manager spawn mvp-review --execute
```

Result (abbreviated; `ok: true`, `mode: "executed"`, herdr status 0):

- adapterId: `grok-build`
- route: `{ "kind": "grok", "model": "grok-build" }`
- intended/executed:

```
herdr worktree create \
  --cwd /workspace/harness \
  --branch harness/mvp-review \
  --label harness:mvp-review \
  --no-focus
```

Herdr created:

| field | value |
| --- | --- |
| worktree path | `/home/box/.herdr/worktrees/harness/harness-mvp-review` |
| branch | `harness/mvp-review` |
| workspace | `w2` (`harness:mvp-review`) |
| pane | `w2:p1` |
| checkout HEAD | `5666612ed8a0ef7f21ea2db76ed879d7741afece` |

Full herdr stdout type: `worktree_created` with `result.worktree.path` and `result.workspace.workspace_id=w2`.

Re-run without removing the worktree fails as expected (`already exists`) — reported in manager JSON `results[0].status=1`, not silent.

## 3) Route still works

```
$ harness manager route mvp-review
{
  "ok": true,
  "adapterId": "grok-build",
  "route": { "kind": "grok", "model": "grok-build" },
  "task": { "id": "mvp-review", "adapter": "grok-build", "worktree": { "branch": "harness/mvp-review" } }
}
```

## 4) herdr worktree list

```
$ herdr worktree list --cwd /workspace/harness
```

Shows:

- `/workspace/harness` — branch `master`, workspace `w1`
- `/home/box/.herdr/worktrees/harness/harness-mvp-review` — branch `harness/mvp-review`, workspace `w2`

## Notes / stop line

- No code fix required after HEAD existed; spawn succeeded on first `--execute`.
- Child tab/agent create after worktree remains a stub (`todo` in manager JSON).
- Gateway/chat ingress **not** started (per MVP-4 stop line).
