# MVP-5 evidence — 2026-09-15

v0.0.4. Local gateway stub. No Matrix/Telegram network. Did not touch herdr-desk.

## start / status / idempotent start

```
$ harness gateway start
{
  "ok": true,
  "pid": 2513320,
  "bind": { "hostname": "127.0.0.1", "port": 8787 },
  "listening": true,
  "alreadyRunning": false
}

$ harness gateway start
{ "ok": true, "alreadyRunning": true, "pid": 2513320, ... }

$ harness gateway status
{ "ok": true, "listening": true, "pid": 2513320, "bind": { "hostname": "127.0.0.1", "port": 8787 }, "lastEvent": null, "version": "0.0.4" }
```

## health

```
$ curl -sS http://127.0.0.1:8787/health
{"ok":true,"service":"harness-gateway","version":"0.0.4","bind":{"hostname":"127.0.0.1","port":8787}}
```

## POST /ingress/matrix → 202

```
HTTP/1.1 202 Accepted
{"ok":true,"source":"matrix","queued":1,"task":{"id":"mvp-review","text":"task: mvp-review please","sender":"@alice:localhost","channel":"!fake:localhost","adapterId":"grok-build","freeform":false},"route":{"kind":"grok","model":"grok-build"},"lastEvent":"2026-09-15T19:51:32.962Z"}
```

## POST /ingress/telegram → 202

```
HTTP/1.1 202 Accepted
{"ok":true,"source":"telegram","queued":2,"task":{"id":"docs","text":"/run docs","sender":"bob","channel":"1","adapterId":"claude","freeform":false},"route":{"kind":"claude"},"lastEvent":"2026-09-15T19:51:32.973Z"}
```

## stop

```
$ harness gateway stop
{ "ok": true, "stopped": true, "pid": 2513320 }

$ harness gateway status
{ "ok": true, "listening": false, "pid": null, "version": "0.0.4", "lastEvent": { "source": "telegram", "taskId": "docs", ... } }
```

## other CLI still works

`harness status --json` → `version: 0.0.4`  
`harness manager route docs` → `adapterId: claude`  
`harness resume` → session `05017eba-3425-4fec-90f2-682384a8791f`
