# MVP-6 evidence — 2026-09-15

v0.0.5. On-demand only (no cron). GitHub API not called. herdr-desk not touched. No commit.

## status --json

`ok: true`, `version: "0.0.5"`

## sentry ingest

```
$ harness issues ingest --source sentry --file /tmp/sentry-event.json
path: /home/box/.local/state/herdr-harness/issues/sentry-abc.json
playbook: desk:sentry-issues
status: mock-draft
title: [sentry] harness: TypeError: boom
github: not called (mock-draft)
```

Draft snippet: labels `mock, sentry, error, desk:sentry-issues`; fingerprint `abc`; culprit `src/cli.ts`.

## bugsink ingest (stdin)

```
$ echo '{...}' | harness issues ingest --source bugsink
path: /home/box/.local/state/herdr-harness/issues/bugsink-bs-1.json
title: [bugsink] harness: ValueError: nope
```

`harness issues list` → count 2.

## pick

```
$ harness pick --json
{
  "ok": true,
  "id": "issue:bs-1",
  "kind": "issue",
  "adapter": "grok-build",
  "reason": "priority: mock issues first (desk:sentry-issues)",
  "title": "[bugsink] harness: ValueError: nope",
  "rules": ["mock issues > named tasks by list order > freeform queue"]
}
```

## summary (markdown, on-demand)

Version 0.0.5; lastPicked `issue:bs-1`; playbook `desk:sentry-issues`; two mock drafts; note “No cron.”

## still green

`harness resume` session `05017eba-3425-4fec-90f2-682384a8791f`  
`harness manager route mvp-review` → grok-build

## gateway ingest (after restart)

Restart required so the new process loads `/ingress/sentry` and `/ingress/bugsink`.

`POST /ingress/sentry` → 202, draft `.../issues/sentry-gw-s.json`  
`POST /ingress/bugsink` → 202, `status: mock-draft`
