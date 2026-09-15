# MVP-1 evidence — 2026-09-15

Verified from `/workspace/harness`. Did not touch `/workspace/herdr-desk`. No GitHub push.

## Link

```bash
chmod +x bin/harness
mkdir -p ~/.local/bin
ln -sfn /workspace/harness/bin/harness ~/.local/bin/harness
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
which harness
# /home/box/.local/bin/harness
```

`bin/harness` resolves the symlink with `readlink -f` so `HERDR_PLUGIN_ROOT` / checkout root is `/workspace/harness`.

## `harness start`

```
ok
harness started at 2026-09-15T19:40:02.727Z
```

## `harness status --json`

```json
{
  "ok": true,
  "plugin": "harness",
  "version": "0.0.1",
  "started": true,
  "startedAt": "2026-09-15T19:40:02.727Z",
  "root": "/workspace/harness",
  "stateFile": "/home/box/.local/state/herdr-harness/state.json"
}
```

Same JSON from `./bin/harness status --json` and from `harness status` (non-TTY).

## `herdr-plugin.toml`

```
id= harness version= 0.0.1
actions= ['start', 'status', 'upgrade', 'resume']
toml ok
```

Parsed with Python `tomllib`. Actions point at `bin/harness`.

## Stubs

`harness upgrade` prints the Ctrl+G hint (no network). `harness resume` is a noop helper.
