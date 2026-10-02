# Plan 029: Drop the absolute path from the unauthenticated issue-draft 202 (residual of plan 017)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 23f7471..HEAD -- src/gateway.ts tests/gateway-ingress-caps.test.ts tests/issues-bounds.test.ts`
> If `projectIssueDraft` already omits `path`, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW
- **Depends on:** `plans/017-project-status-last-delivery.md` (shipped), `plans/015-bound-issue-draft-directory.md` (shipped)
- **Category:** security
- **Confidence:** HIGH (reproduced 2026-10-02 against `23f7471`)
- **Planned at:** commit `23f7471`, 2026-10-02 (Run 6)

## Why this matters

`projectIssueDraft` (`src/gateway.ts:747`) includes `path: draft.path` — an absolute path under `$HOME` — in the **202 answer to an unauthenticated POST** on both `/ingress/sentry` and `/ingress/bugsink`.

Plan 017 identified exactly this leak on the sibling route and removed exactly these fields. Its comment (`src/gateway.ts:724`) states the rule:

> `/status` is unauthenticated too, and the delivery record names three absolute paths under the user's home […] **each embedding the OS username**. […] the projection keeps what identifies a delivery and its size, and drops the filesystem layout.

`projectDelivery` (`src/gateway.ts:732`) returns `{kind, at, bytes, excerpt}` — no paths. `projectIssueDraft` was written afterwards and kept the path. 017 fixed one projection and did not state the rule as general.

A caller who can reach the port learns the OS username and the exact on-disk location and naming scheme of the state directory. Impact is bounded (no file contents, no read primitive) but it is a free username + filesystem-layout disclosure on a route documented as unauthenticated — the last unprojected absolute path on that class of route.

## Current state

```ts
function projectIssueDraft(draft: IssueDraft): Record<string, unknown> {
  const projection: Record<string, unknown> = {
    id: draft.id,
    fingerprint: draft.fingerprint,
    title: draft.title,
    source: draft.source,
    playbook: draft.playbook,
    labels: draft.labels,
    status: draft.status,
    path: draft.path,          // <-- absolute; embeds $HOME / OS username
    createdAt: draft.createdAt,
  };
  ...
}
```

## Evidence

```
$ curl -sS -X POST localhost:<port>/ingress/sentry -d @event.json
path = /home/<user>/.local/state/herdr-harness/issues/sentry-~73500ae1….json
projection keys include: path
```

Reproduced 2026-10-02 at `23f7471` with an isolated `HOME` and a real gateway on a high port.

## Steps

1. Remove `path` from `projectIssueDraft`. Nothing else.
2. Do **not** add an Origin or auth check — `README.md:163` states stub replies stay ungated by decision; this plan does not re-litigate that.
3. Leave `harness issues list --json` returning `path` (`src/cli.ts:1146`) — that is the ungated *local* reader, not an unauthenticated network route.

The draft **filename** is deterministic from `fingerprint` (`src/issues.ts:162`), so a caller keeps every correlation value it has today.

## Tests

Extend `tests/gateway-ingress-caps.test.ts` (or the issues-bounds gateway fixture):

- POST to both `/ingress/sentry` and `/ingress/bugsink` → response has **no** `path` key.
- Response still carries `fingerprint`, `title`, `status`, `createdAt`.
- Ordinary (small) event response otherwise byte-identical to before (no new keys).
- Mutation-check: re-add `path` and confirm the test fails.

## STOP conditions

- Widening to Origin/auth on ingress — that re-litigates `README.md:163`; stop and record rather than ship.
- Removing `path` from the CLI `issues list` output — out of scope.

## Acceptance

- Unauthenticated issue-draft 202s carry no absolute path.
- Local `harness issues list --json` still returns `path`.
- 185+ tests green; `bun run typecheck` exit 0.
