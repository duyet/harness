# MVP-7 evidence — 2026-09-15

v0.0.6. No cron. No commit. herdr-desk not touched.

## status / resume / manager

`harness status --json` → `version: "0.0.6"`, `ok: true`  
`harness resume` → session `05017eba-3425-4fec-90f2-682384a8791f`  
`harness manager route docs` → `adapterId: claude`

## gateway start

```
$ harness gateway start
{"ok":true,"pid":2519886,"bind":{"hostname":"127.0.0.1","port":8787},"listening":true,"alreadyRunning":false}
```

## GET /  (HTML chat)

```
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
<title>Harness chat</title>
```

`GET /chat` same `text/html`.

## GET /health

```
HTTP/1.1 200 OK
{"ok":true,"service":"harness-gateway","version":"0.0.6","bind":{"hostname":"127.0.0.1","port":8787}}
```

## POST /chat

```
$ curl -sS -X POST http://127.0.0.1:8787/chat \
  -H 'content-type: application/json' \
  -d '{"text":"task: mvp-review"}'
{"ok":true,"reply":"stub: routed task mvp-review → adapter grok-build (grok). No LLM.","task":{"id":"mvp-review","text":"task: mvp-review","sender":"chat-ui","channel":"local","adapterId":"grok-build","freeform":false},"route":{"kind":"grok","model":"grok-build"},"lastEvent":"2026-09-15T19:57:13.192Z","queued":5}
```

## stop

```
$ harness gateway stop
{"ok":true,"stopped":true,"pid":2519886}
```
