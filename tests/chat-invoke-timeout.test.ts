import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixture } from "./helpers.ts";

// Plan 039: `README.md:157` promises the chat endpoint "never hangs or 500s on
// adapters", but `invokeAdapter` had one settle path — the child's `close` — and
// `close` waits for stdio EOF. An adapter that backgrounds work leaves a
// grandchild holding the inherited stdout, so a 1s timeout left the promise
// unsettled indefinitely: a hang, not just the orphan-process leak the deferred
// note described. The runner asserts in its own process against the real
// invokeAdapter, so a never-settling promise surfaces as that process being
// capped rather than as a hang across the test boundary.
const RUNNER = new URL(
  "./fixtures/chat-invoke-timeout-runner.ts",
  import.meta.url,
).href;
const PIDS = "orphan-pids.txt";
let fixture: ReturnType<typeof createFixture>;
let fakeBin: string;
let scratch: string;
// Every process the fake adapters backgrounded, across the whole file, so
// afterAll can clean up a survivor even when the assertion that would have
// noticed it also failed.
const survivors = new Set<number>();

function recordedPids(): number[] {
  try {
    return readFileSync(join(scratch, PIDS), "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function run(mode: string) {
  fixture.assertIsolation();
  const started = Date.now();
  let result: ReturnType<typeof fixture.runCode>;
  try {
    result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}, ${JSON.stringify(fakeBin)}, ${JSON.stringify(scratch)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  } finally {
    // Bookkeeping in a finally: neither a failing assertion below nor a
    // runner the spawn cap just SIGKILLed may be the reason one of these
    // adapters' processes outlives the suite.
    for (const pid of recordedPids()) survivors.add(pid);
  }
  const elapsed = Date.now() - started;
  // spawnSync SIGKILLs at 30s and reports a null status, so a pipe left open by
  // a killed adapter fails here as a hang instead of passing quietly.
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.mode).toBe(mode);
  return { ...parsed, elapsed };
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  fakeBin = join(fixture.root, "bin");
  scratch = join(fixture.root, "scratch");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  fixture?.cleanup();
});

afterAll(() => {
  // The fake adapters background real processes, and one of them escapes the
  // process group on purpose. Anything still alive when the suite ends came
  // from an adapter, never from the harness.
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  survivors.clear();
});

describe("invokeAdapter bounds the request, not just the child (isolated)", () => {
  test("a grandchild holding stdout cannot outlive the timeout", () => {
    // The pre-039 shape: the adapter backgrounds work, exits, and the promise
    // waits on a pipe EOF only the grandchild's death would bring.
    run("grandchild-hold");
  });

  test("a grandchild that escapes the process group still cannot hang the call", () => {
    // Pins the timer's own settle path with the group kill unable to help.
    run("escaped-grandchild");
  });

  test("a grandchild is killed with the direct child, not left to reparent", () => {
    // Checked by pid, and by the work it would have gone on to do.
    run("group-kill");
  });

  test("a direct child that never closes stdout is bounded too", () => {
    run("self-hold");
  });
});

describe("invokeAdapter keeps its existing result shapes (isolated)", () => {
  test("a successful run resolves on close with its full stdout", () => {
    run("happy-path");
  });

  test("stdout larger than one pipe read arrives whole", () => {
    run("full-stdout");
  });

  test("a non-zero exit keeps its status and message", () => {
    run("nonzero-exit");
  });

  test("a non-zero exit with stderr keeps its detail", () => {
    run("stderr-nonzero-exit");
  });

  test("a spawn failure keeps its ENOENT message", () => {
    run("spawn-enoent");
  });
});

describe("the fake adapters leak nothing (isolated)", () => {
  test("every process these adapters started was booked for cleanup", () => {
    // Guards the afterAll bookkeeping itself. Read at the wrong moment it is
    // silently empty, the escaped grandchild survives, and the suite still
    // passes — which is exactly how it went wrong once already.
    expect(survivors.size).toBeGreaterThan(0);
  });
});
