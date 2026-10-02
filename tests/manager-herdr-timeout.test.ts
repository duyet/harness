import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/manager-spawn-runner.ts", import.meta.url).href;
const CLI = new URL("../src/cli.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

// The clamp floor, so the hang cases exercise a real 1s budget instead of
// waiting out the 60s default. HARNESS_HERDR_TIMEOUT_MS=300 would be raised to
// this same floor — that clamp is covered as a unit case below.
const SHORT_MS = "1000";
// Wall-clock bounds are asserted against the test timeout, never against the
// configured value, so a loaded CI box cannot make these flaky.
const PROMPT_MS = 15_000;

function spawnsFile() {
  return join(fixture.home, ".local", "state", "herdr-harness", "spawns.json");
}

function readSpawns() {
  return JSON.parse(readFileSync(spawnsFile(), "utf8")).spawns;
}

function herdrPid(): number | null {
  const path = join(fixture.root, "herdr-pid.txt");
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : null;
}

// The timed-out child must actually be dead, not merely un-reaped. Retried
// briefly because an unreaped process can still answer signal 0.
function expectChildGone() {
  const pid = herdrPid();
  expect(pid).not.toBeNull();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid!, 0);
    } catch {
      return;
    }
    Bun.sleepSync(50);
  }
  throw new Error(`fixture herdr (pid ${pid}) still alive after the spawn returned`);
}

function calls(): string[][] {
  return JSON.parse(readFileSync(join(fixture.root, "manager-calls.json"), "utf8"));
}

function worktreeArgs() {
  return ["worktree", "create", "--cwd", fixture.cwd, "--branch", "fixture-branch",
    "--base", "fixture-base", "--path", join(fixture.root, "worktree"), "--label", "fixture-label", "--no-focus"];
}

function run(mode: string, timeoutEnv = "") {
  fixture.assertIsolation();
  const started = Date.now();
  const child = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)},
      ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}, ${JSON.stringify(timeoutEnv)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  const elapsedMs = Date.now() - started;
  expect(child.stderr).toBe("");
  return { ...child, elapsedMs, json: JSON.parse(child.stdout) };
}

// cli.ts runs its main on import, so argv is pointed at "help" — a branch that
// prints usage to stdout and returns without exiting. The result goes to stderr
// so it can be parsed without the usage text.
function resolveTimeout(raw: string | undefined) {
  const seed =
    raw === undefined
      ? "delete process.env.HARNESS_HERDR_TIMEOUT_MS;"
      : `process.env.HARNESS_HERDR_TIMEOUT_MS = ${JSON.stringify(raw)};`;
  const result = fixture.runCode(`
    ${seed}
    process.argv = [process.execPath, ${JSON.stringify(CLI)}, "help"];
    const m = await import(${JSON.stringify(CLI)});
    console.error(JSON.stringify({
      ms: m.herdrTimeoutMs(),
      env: m.HERDR_TIMEOUT_ENV,
      def: m.DEFAULT_HERDR_TIMEOUT_MS,
      min: m.MIN_HERDR_TIMEOUT_MS,
      max: m.MAX_HERDR_TIMEOUT_MS,
    }));
  `);
  expect(result.exit).toBe(0);
  return JSON.parse(result.stderr);
}

beforeEach(() => {
  fixture = createFixture();
  writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify({
    adapters: {
      default: "fixture-adapter",
      routes: { "fixture-adapter": { kind: "grok", model: "grok-build", flags: ["--verbose"] } },
    },
    tasks: [{ id: "fixture-task", worktree: {
      branch: "fixture-branch", base: "fixture-base", path: join(fixture.root, "worktree"), label: "fixture-label",
    } }],
  }));
});

afterEach(() => {
  fixture?.cleanup();
});

describe("herdrTimeoutMs", () => {
  test("uses its own env var, distinct from the chat and gh timeouts", () => {
    const t = resolveTimeout(undefined);
    expect(t.env).toBe("HARNESS_HERDR_TIMEOUT_MS");
    expect(t.env).not.toBe("HARNESS_CHAT_TIMEOUT_MS");
    expect(t.env).not.toBe("HARNESS_GH_TIMEOUT_MS");
  });

  test("falls back to the 60s default for unset, non-numeric and non-positive", () => {
    for (const raw of [undefined, "", "   ", "abc", "1e", "0", "-1", "-5000", "NaN"]) {
      expect(resolveTimeout(raw).ms).toBe(60_000);
    }
  });

  test("clamps to [1000, 300000] in both directions and floors fractions", () => {
    const { min, max } = resolveTimeout(undefined);
    expect(min).toBe(1_000);
    expect(max).toBe(300_000);
    expect(resolveTimeout("1").ms).toBe(min);
    expect(resolveTimeout("300").ms).toBe(min);
    expect(resolveTimeout("999").ms).toBe(min);
    expect(resolveTimeout("1234.9").ms).toBe(1234);
    expect(resolveTimeout("900000").ms).toBe(max);
    expect(resolveTimeout("2500").ms).toBe(2500);
  });
});

// Bun 1.4.2 ignores a describe-level timeout, so every case that waits on a
// hung child carries its own. Generous on purpose: PROMPT_MS is the assertion
// that must fail first, with a readable message, rather than the test timeout.
const HANG_TEST_MS = 30_000;

describe("herdr timeout: envelopes that must not change", () => {
  // Case 1. Bounding the spawn must be invisible on the success path: same
  // exit, same envelope, same recorded argv, and no `timedOut` leaking out.
  test("a healthy herdr still spawns worktree, tab and agent unchanged", () => {
    const result = run("success", SHORT_MS);
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed" });
    expect(calls()).toEqual([
      ["--version"],
      worktreeArgs(),
      ["tab", "create", "--workspace", "w1", "--cwd", join(fixture.root, "worktree"),
        "--label", "harness:fixture-task", "--no-focus"],
      ["agent", "start", "harness:fixture-task", "--kind", "grok", "--pane", "w1:t2:p1",
        "--", "--model", "grok-build", "--verbose"],
    ]);
    expect(result.json.results.map((r: { status: number }) => r.status)).toEqual([0, 0, 0]);
    expect(result.json.results.map((r: { timedOut?: boolean }) => r.timedOut)).toEqual([undefined, undefined, undefined]);
    expect(readSpawns()["fixture-task"]).toMatchObject({ workspaceId: "w1", tabId: "w1:t2", paneId: "w1:t2:p1" });
  });

  // Case 2. A plain nonzero exit keeps the pre-existing envelope, hint and exit.
  test("a herdr that exits nonzero still yields the existing failure envelope and exit 1", () => {
    const result = run("nonzero", SHORT_MS);
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.error).toBe("herdr worktree create failed");
    expect(result.json.hint).toBe(
      "if a worktree/tab already exists for this task, re-run with --replace or `harness manager cleanup <taskId>` first",
    );
    expect(result.json.results).toHaveLength(1);
    expect(result.json.results[0].status).toBe(7);
    expect(result.json.results[0].timedOut).toBeUndefined();
    expect(result.json.results[0].stderr).toBe("fixture stderr");
    // Bounded but not expired: a fast failure must not pick up timeout wording.
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
  });
});

describe("herdr timeout: bounded spawn", () => {
  // Case 3. The headline hang: worktree create never returns.
  test("a herdr that never returns on worktree create is killed and reported as a timeout", () => {
    const result = run("hang-worktree", SHORT_MS);
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.error).toBe("herdr worktree create failed");
    // A timeout lands in the ordinary step-failure path, not a new envelope.
    expect(result.json.results).toHaveLength(1);
    expect(result.json.results[0].status).toBeNull();
    expect(result.json.results[0].timedOut).toBe(true);
    expect(result.json.results[0].stderr).toContain("herdr timed out after 1000ms and was killed");
    // The argv herdr would have received is unchanged by bounding the spawn.
    expect(result.json.results[0].command.slice(1)).toEqual(worktreeArgs());
    expect(result.json.hint).toContain("harness manager cleanup");
    expect(result.json.recover).toBeUndefined();
    // Bounded: the CLI returned on its timer, nowhere near the 30s the test
    // harness itself would allow.
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    expectChildGone();
  }, HANG_TEST_MS);

  // Case 4. Step 1 succeeds, step 2 wedges: the plan-011 recovery path must
  // still fire, and the index-based argv re-rendering must not shift.
  test("a herdr that hangs on tab create still emits the plan-011 hint and recover commands", () => {
    const result = run("hang-tab", SHORT_MS);
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.error).toBe("herdr tab create failed");
    expect(result.json.results).toHaveLength(2);
    expect(result.json.results[0].status).toBe(0);
    expect(result.json.results[1].timedOut).toBe(true);
    expect(result.json.hint).toContain("no child tab");
    expect(result.json.hint).toContain("--replace");
    expect(result.json.recover).toEqual([
      "harness manager cleanup fixture-task --execute",
      "harness manager spawn fixture-task --replace",
    ]);
    // argvFor(i) re-renders step 1 from the parsed worktree id, so a timeout on
    // step 2 must leave step 1's recorded argv exactly as it was.
    expect(result.json.results[0].command.slice(1)).toEqual(worktreeArgs());
    expect(result.json.results[1].command.slice(1, 3)).toEqual(["tab", "create"]);
    expect(result.json.results[1].command).toContain("w1");
    expect(readSpawns()["fixture-task"]).toMatchObject({ workspaceId: "w1", tabId: "w1:t1" });
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    expectChildGone();
  }, HANG_TEST_MS);

  // Case 5. The probe itself wedging used to hang the CLI before it could say
  // anything. Every path must now come back promptly.
  test("a herdr that never answers --version returns promptly on the execute path", () => {
    const result = run("hang-version", SHORT_MS);
    // Not a crash: an unusable herdr is a successful dry-run fallback, as before.
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "dry-run" });
    expect(result.json.herdr.ok).toBe(false);
    expect(result.json.herdr.reason).toContain("--version timed out after 1000ms");
    expect(result.json.skippedExecute).toBe(result.json.herdr.reason);
    expect(result.json.results).toBeUndefined();
    expect(calls()).toEqual([["--version"]]);
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    expectChildGone();
  }, HANG_TEST_MS);

  test("a dry run performs no subprocess at all, probe included", () => {
    const result = run("dry-run", SHORT_MS);
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "dry-run" });
    // The documented safe default: a wedged herdr cannot hang it, because the
    // probe is deferred until --execute.
    expect(calls()).toEqual([]);
    expect(result.json.herdr).toBeNull();
    expect(result.json.skippedExecute).toContain("default is dry-run");
    expect(result.json.todo.join(" ")).toContain("deferred until --execute");
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    expect(herdrPid()).toBeNull();
  });

  test("an unknown task performs no subprocess at all", () => {
    const result = run("unknown", SHORT_MS);
    expect(result.exit).toBe(1);
    expect(result.json).toMatchObject({ ok: false, mode: "dry-run", error: "unknown task: unknown-task" });
    expect(result.json.herdr).toBeNull();
    expect(calls()).toEqual([]);
    expect(herdrPid()).toBeNull();
  });

  // Case 6. A cleanup that cannot complete must leave the spawn record alone:
  // executeCleanup only calls deleteSpawn when every step returned 0.
  test("a hanging herdr during cleanup --execute keeps the spawn record on disk", () => {
    const result = run("hang-cleanup", SHORT_MS);
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.cleanup.ok).toBe(false);
    expect(result.json.cleanup.error).toBe("herdr discovery failed; not safe to clean up");
    expect(result.json.cleanup.results[0].timedOut).toBe(true);
    expect(result.json.cleanup.results[0].stderr).toContain("herdr timed out after 1000ms");
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    // The load-bearing invariant: a timeout is a failure, so the record stays
    // and the operator can still find and re-run the cleanup. The seeded `at`
    // proves the record was left as-is rather than rewritten.
    expect(readSpawns()["fixture-task"]).toMatchObject({
      taskId: "fixture-task",
      workspaceId: "w9",
      tabId: "w9:t9",
      paneId: "w9:t9:p1",
      at: "2026-01-01T00:00:00.000Z",
    });
    expectChildGone();
  }, HANG_TEST_MS);

  // Case 7. Every rejected or clamped value still yields a working, bounded
  // spawn rather than an unbounded one.
  test("unset, non-numeric, non-positive and clamped timeout values still spawn", () => {
    for (const raw of ["", "not-a-number", "0", "-9", "1", "300", "900000"]) {
      fixture.cleanup();
      fixture = createFixture();
      writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify({
        adapters: { default: "fixture-adapter", routes: { "fixture-adapter": { kind: "grok" } } },
        tasks: [{ id: "fixture-task" }],
      }));
      const result = run("success", raw);
      expect(result.json.ok).toBe(true);
      expect(result.json.mode).toBe("executed");
      expect(result.json.results.map((r: { status: number }) => r.status)).toEqual([0, 0, 0]);
      expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    }
  }, 60_000);

  // A clamped-low value must still bound the hang, not disable it.
  test("a below-floor timeout is raised to the floor and still bounds the hang", () => {
    const result = run("hang-worktree", "300");
    expect(result.exit).toBe(1);
    expect(result.json.results[0].timedOut).toBe(true);
    expect(result.json.results[0].stderr).toContain("herdr timed out after 1000ms");
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    expectChildGone();
  }, HANG_TEST_MS);
});
