import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Plan 039: `invokeAdapter` settled its promise from exactly one place — the
// child's `close` event, which waits for stdio EOF. An adapter that backgrounds
// work leaves a grandchild holding the inherited fds, so EOF never came and the
// promise stayed unsettled however long that grandchild lived: a documented
// hang on an unauthenticated route. This runner drives the real invokeAdapter
// against fake adapters that have exactly that shape.
const [mode, home, cwd, fakeBin, scratch] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;

const { invokeAdapter } = await import("../../src/chat.ts");

const TIMEOUT_MS = 1_000;
// Time-to-settle is the assertion that matters: pre-039 these promises never
// returned at all, so a test that only checked the eventual result once it
// arrived could not have caught it. The ceiling is a multiple of the timeout
// because a loaded CI box schedules late; it is still finite, which is the
// whole point.
const SETTLE_CEILING_MS = 3 * TIMEOUT_MS;
const leakFile = join(scratch, "grandchild-leak.txt");
const orphanLog = join(scratch, "orphan-pids.txt");
process.env.ORPHAN_LOG = orphanLog;
process.env.LEAK_FILE = leakFile;

function writeAdapter(name: string, body: string) {
  writeFileSync(join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Background a process that outlives the direct child and, through the fds it
// inherited, holds the adapter's stdout open. `$!` is logged so the test can
// assert the pid is really gone; a survivor that the kill missed is the whole
// failure mode being pinned.
writeAdapter(
  "hang-adapter",
  `: "\${ORPHAN_LOG:?}"\n( sleep 300 ) &\necho $! >> "$ORPHAN_LOG"`,
);
// Same, but the grandchild does visible work well after the timeout, so the
// group kill is checked by what it prevented rather than by a pid that may have
// been reparented and reaped.
writeAdapter(
  "leak-adapter",
  `: "\${LEAK_FILE:?}"\n( sleep 2; printf 'leaked\\n' > "$LEAK_FILE" ) &\necho $! >> "$ORPHAN_LOG"`,
);
// Leaves the adapter's process group entirely, so a group kill cannot reach
// it. The pipe stays open regardless: this is the timer's own settle path
// pinned with the process-group kill unable to help.
writeAdapter(
  "escape-adapter",
  `: "\${ORPHAN_LOG:?}"\nsetsid sh -c 'echo $$ >> "$ORPHAN_LOG"; exec sleep 30' &`,
);
// The direct child itself never exits and never closes stdout.
writeAdapter("self-hold-adapter", `exec sleep 300`);
// A successful run: a small literal reply plus a body far larger than one pipe
// read, so a fix that resolved the timer unconditionally would truncate it.
writeAdapter(
  "reply-adapter",
  `printf 'mock-adapter-reply:'\nfor a in "$@"; do printf ' <%s>' "$a"; done\nprintf '\\n'`,
);
writeAdapter(
  "big-adapter",
  `printf 'BEGIN\\n'\ni=0\nwhile [ $i -lt 6000 ]; do printf 'abcdefghij'; i=$((i + 1)); done\nprintf '\\nEND\\n'`,
);
writeAdapter(
  "fail-adapter",
  `echo fixture-adapter-failed >&2\nexit 3`,
);
writeAdapter("quiet-fail-adapter", `exit 3`);

const BIG_STDOUT = `BEGIN\n${"abcdefghij".repeat(6000)}\nEND`;

function orphanPids(): number[] {
  if (!existsSync(orphanLog)) return [];
  return readFileSync(orphanLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// `kill(pid, 0)` succeeds against a zombie, and an orphan the gateway did not
// reap reads as alive forever, so liveness is read from /proc instead. Null is
// "no such pid"; Z/X are dead-but-unreaped and are exactly what a killed
// orphan reparents to.
function processState(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const afterComm = stat.lastIndexOf(")") + 2;
  return stat.slice(afterComm, afterComm + 1);
}

// A SIGKILLed process is not off the run queue the instant the signal is
// sent, so the state is polled for a beat rather than read once. Anything still
// running when the beat is up outlived the kill.
async function assertNotRunning(pid: number, what: string) {
  let state = processState(pid);
  for (let i = 0; i < 40 && state !== null && state !== "Z" && state !== "X"; i++) {
    await delay(25);
    state = processState(pid);
  }
  assert(
    state === null || state === "Z" || state === "X",
    `${what} (pid ${pid}) is still running: /proc state ${state}`,
  );
}

// Rejects rather than hanging the test run: a promise that never settles is the
// defect, so the failure has to read as "unsettled after Nms" and not as some
// downstream assertion about a value that never arrived.
async function settledWithin<T>(promise: Promise<T>, ceilingMs: number) {
  let guard: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    guard = setTimeout(
      () => reject(new Error(`promise still unsettled after ${ceilingMs}ms`)),
      ceilingMs,
    );
  });
  const started = Date.now();
  try {
    const value = await Promise.race([promise, expiry]);
    return { value, elapsed: Date.now() - started };
  } finally {
    clearTimeout(guard);
  }
}

if (mode === "happy-path") {
  const res = await invokeAdapter(["reply-adapter", "hello world"], TIMEOUT_MS);
  assert.equal(res.ok, true);
  assert.equal(res.status, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.error, undefined);
  assert.equal(res.stdout, "mock-adapter-reply: <hello world>");
} else if (mode === "full-stdout") {
  const res = await invokeAdapter(["big-adapter"], TIMEOUT_MS);
  assert.equal(res.ok, true);
  assert.equal(res.status, 0);
  assert.equal(res.timedOut, false);
  // 60 KB crosses the stream's highWaterMark many times over: full stdout, not
  // whatever had arrived by the time the child was reaped.
  assert.equal(res.stdout, BIG_STDOUT);
  assert.equal(res.stdout.length, BIG_STDOUT.length);
} else if (mode === "nonzero-exit") {
  const res = await invokeAdapter(["quiet-fail-adapter"], TIMEOUT_MS);
  assert.equal(res.ok, false);
  assert.equal(res.status, 3);
  assert.equal(res.timedOut, false);
  assert.equal(res.stdout, "");
  assert.equal(res.error, "exit 3");
} else if (mode === "stderr-nonzero-exit") {
  const res = await invokeAdapter(["fail-adapter"], TIMEOUT_MS);
  assert.equal(res.ok, false);
  assert.equal(res.status, 3);
  assert.equal(res.timedOut, false);
  assert.equal(res.stdout, "");
  assert.equal(res.error, "exit 3: fixture-adapter-failed");
} else if (mode === "spawn-enoent") {
  // Two shapes of "the binary is not there", both reached here the same way:
  // the spawn's `error` event wins the race against a `close` of -2. The
  // `spawn failed: ` prefix is ours; the rest is the runtime's wording, so
  // each is pinned only as far as this repo owns it.
  const missing = await invokeAdapter(
    [join(fakeBin, "fixture-no-such-adapter-binary")],
    TIMEOUT_MS,
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.status, null);
  assert.equal(missing.timedOut, false);
  assert.equal(missing.stdout, "");
  assert.match(missing.error ?? "", /^spawn failed: /);
  assert.match(missing.error ?? "", /ENOENT/);
  const offPath = await invokeAdapter(["fixture-no-such-adapter-binary"], TIMEOUT_MS);
  assert.equal(offPath.ok, false);
  assert.equal(offPath.status, null);
  assert.equal(offPath.timedOut, false);
  assert.match(offPath.error ?? "", /^spawn failed: /);
  assert.match(offPath.error ?? "", /fixture-no-such-adapter-binary/);
  assert(orphanPids().length === 0, "a spawn failure must spawn nothing");
} else if (mode === "grandchild-hold") {
  // The documented hang. Pre-039 this promise stayed unsettled for as long as
  // the grandchild lived — indefinitely, for one that never exits.
  const { value: res, elapsed } = await settledWithin(
    invokeAdapter(["hang-adapter"], TIMEOUT_MS),
    SETTLE_CEILING_MS,
  );
  assert(
    elapsed < SETTLE_CEILING_MS,
    `settled at ${elapsed}ms, past the ${SETTLE_CEILING_MS}ms ceiling`,
  );
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.status, null);
  assert.equal(res.stdout, "");
  assert.equal(res.error, `timed out after ${TIMEOUT_MS}ms`);
  const pids = orphanPids();
  assert.equal(pids.length, 1, `expected one grandchild, logged ${pids}`);
  await assertNotRunning(pids[0], "grandchild holding the adapter's stdout");
} else if (mode === "escaped-grandchild") {
  // The grandchild leaves the process group the adapter was given, so the
  // group kill cannot reach it and the pipe is still open when the timer
  // fires. Only the timer's own settle path can answer this one.
  const { value: res, elapsed } = await settledWithin(
    invokeAdapter(["escape-adapter"], TIMEOUT_MS),
    SETTLE_CEILING_MS,
  );
  assert(
    elapsed < SETTLE_CEILING_MS,
    `settled at ${elapsed}ms, past the ${SETTLE_CEILING_MS}ms ceiling`,
  );
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.error, `timed out after ${TIMEOUT_MS}ms`);
  const pids = orphanPids();
  assert.equal(pids.length, 1, `expected one escaped grandchild, logged ${pids}`);
} else if (mode === "group-kill") {
  // The grandchild would write a file two seconds out, well past the one
  // second timeout, and is checked by pid as well: a survivor is the
  // deferred grandchild-kill note this absorbs.
  const { value: res, elapsed } = await settledWithin(
    invokeAdapter(["leak-adapter"], TIMEOUT_MS),
    SETTLE_CEILING_MS,
  );
  assert(
    elapsed < SETTLE_CEILING_MS,
    `settled at ${elapsed}ms, past the ${SETTLE_CEILING_MS}ms ceiling`,
  );
  assert.equal(res.timedOut, true);
  assert.equal(res.error, `timed out after ${TIMEOUT_MS}ms`);
  const pids = orphanPids();
  assert.equal(pids.length, 1, `expected one grandchild, logged ${pids}`);
  await assertNotRunning(pids[0], "grandchild that outlives the direct child");
  // Well past the grandchild's own 2s write, with room for a slow box.
  await delay(3_000);
  assert.equal(
    existsSync(leakFile),
    false,
    "a grandchild that survived the timeout still did its work",
  );
} else if (mode === "self-hold") {
  // The direct child never exits and never closes stdout. Ordinary hang, no
  // grandchild involved.
  const { value: res, elapsed } = await settledWithin(
    invokeAdapter(["self-hold-adapter"], TIMEOUT_MS),
    SETTLE_CEILING_MS,
  );
  assert(
    elapsed < SETTLE_CEILING_MS,
    `settled at ${elapsed}ms, past the ${SETTLE_CEILING_MS}ms ceiling`,
  );
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.status, null);
  assert.equal(res.error, `timed out after ${TIMEOUT_MS}ms`);
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}

// Reaching this line is itself part of the contract: every mode above leaves
// (or kills) a process holding a pipe the gateway once owned, and a stream
// left open would keep this runner alive past its last line of output, where
// the test's spawnSync cap would turn it into a timeout rather than a failure.
console.log(JSON.stringify({ ok: true, mode, orphans: orphanPids() }));
