import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/issues-gh-timeout-runner.ts", import.meta.url).href;
const ISSUES = new URL("../src/issues.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

// The clamp floor, so the timeout cases exercise a real 1s budget rather than
// waiting out the 60s default.
const SHORT_MS = "1000";
// Wall-clock bounds are asserted against the test timeout, never against the
// configured value, so a loaded CI box cannot make these flaky.
const PROMPT_MS = 15_000;

function issuesDir() {
  return join(fixture.home, ".local", "state", "herdr-harness", "issues");
}

function storedDrafts() {
  if (!existsSync(issuesDir())) return [];
  return readdirSync(issuesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(issuesDir(), f), "utf8")));
}

function ghPid(): number | null {
  const path = join(fixture.root, "gh-pid.txt");
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : null;
}

// How many bytes the fixture gh managed to read from stdin.
function ghStdinBytes(): string | null {
  const path = join(fixture.root, "stdin-bytes.txt");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// The timed-out child must actually be dead, not merely un-reaped. Retried
// briefly because an unreaped process can still answer signal 0.
function expectChildGone() {
  const pid = ghPid();
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
  throw new Error(`fixture gh (pid ${pid}) still alive after the spawn returned`);
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

function resolveTimeout(raw: string | undefined) {
  const seed =
    raw === undefined
      ? "delete process.env.HARNESS_GH_TIMEOUT_MS;"
      : `process.env.HARNESS_GH_TIMEOUT_MS = ${JSON.stringify(raw)};`;
  const result = fixture.runCode(`
    ${seed}
    const m = await import(${JSON.stringify(ISSUES)});
    console.log(JSON.stringify({
      ms: m.ghTimeoutMs(),
      env: m.GH_TIMEOUT_ENV,
      def: m.DEFAULT_GH_TIMEOUT_MS,
      min: m.MIN_GH_TIMEOUT_MS,
      max: m.MAX_GH_TIMEOUT_MS,
    }));
  `);
  expect(result.exit).toBe(0);
  return JSON.parse(result.stdout);
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("ghTimeoutMs", () => {
  test("uses its own env var, distinct from the chat timeout", () => {
    const t = resolveTimeout(undefined);
    expect(t.env).toBe("HARNESS_GH_TIMEOUT_MS");
    expect(t.env).not.toBe("HARNESS_CHAT_TIMEOUT_MS");
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

describe("publish timeout: envelopes that must not change", { timeout: 60000 }, () => {
  test("a gh that prints an issue URL still yields ok:true and a github-created draft", () => {
    const result = run("created", SHORT_MS);
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed" });
    expect(result.json.github).toMatchObject({
      status: 0,
      url: "https://github.com/duyet/harness/issues/42",
      issueNumber: 42,
    });
    expect(result.json.github.error).toBeUndefined();
    const [stored] = storedDrafts();
    expect(stored.status).toBe("github-created");
    expect(stored.githubIssueUrl).toBe("https://github.com/duyet/harness/issues/42");
    expect(stored.githubIssueNumber).toBe(42);
    expectChildGone();
  });

  test("a gh that exits nonzero still yields the existing message and exit 1", () => {
    const result = run("fail", SHORT_MS);
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.github.error).toBe("gh issue create exited 4");
    expect(result.json.github.stderr).toContain("not logged in");
    const [stored] = storedDrafts();
    expect(stored.status).toBe("mock-draft");
    expect(stored.githubIssueUrl).toBeUndefined();
    expectChildGone();
  });

  test("a missing gh still yields gh not usable and exit 1", () => {
    const result = run("no-gh", SHORT_MS);
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.github.error).toContain("gh not usable (gh)");
    const [stored] = storedDrafts();
    expect(stored.status).toBe("mock-draft");
    expect(ghPid()).toBeNull();
  });
});

describe("publish timeout: bounded spawn", { timeout: 60000 }, () => {
  test("a gh that never returns is killed and reported as a timeout", () => {
    const result = run("hang", SHORT_MS);
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.github.status).toBeNull();
    expect(result.json.github.error).toContain("timed out after 1000ms");
    // Conservative: we cannot know whether GitHub filed it.
    expect(result.json.github.error).toContain("re-running is safe");
    expect(result.json.github.command.slice(0, 3)).toEqual(["gh", "issue", "create"]);
    // The argv gh would have received is unchanged by bounding the spawn.
    expect(result.json.github.command).toContain("--title");
    expect(result.json.github.command).toContain("--body");
    expect(result.json.github.command).toContain("--label");
    // Bounded: the CLI returned on the timer, nowhere near the 30s the test
    // harness itself would allow.
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    const [stored] = storedDrafts();
    expect(stored.status).toBe("mock-draft");
    expect(stored.githubIssueUrl).toBeUndefined();
    expectChildGone();
  });

  test("a gh that reads stdin is closed off, so it cannot stall the CLI", () => {
    // Bun's spawnSync already hands the child an EOF'd pipe by default, so this
    // pins the explicit stdio: the gh sees no stdin and returns on its own
    // rather than being rescued by the timeout. A stalled read would surface as
    // a timeout here, not as ok:true.
    const result = run("stdin-block", SHORT_MS);
    expect(result.exit).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.github.status).toBe(0);
    expect(ghStdinBytes()).toBe("0");
    expect(result.json.github.url).toBe("https://github.com/duyet/harness/issues/42");
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
    const [stored] = storedDrafts();
    expect(stored.status).toBe("github-created");
    expectChildGone();
  });

  test("unset, non-numeric and clamped timeout values still spawn successfully", () => {
    for (const raw of ["", "not-a-number", "1", "300", "0", "-9"]) {
      fixture.cleanup();
      fixture = createFixture();
      const result = run("created", raw);
      expect(result.json.ok).toBe(true);
      expect(result.json.github.status).toBe(0);
      expect(result.json.github.error).toBeUndefined();
      expect(result.elapsedMs).toBeLessThan(PROMPT_MS);
      const [stored] = storedDrafts();
      expect(stored.status).toBe("github-created");
      expectChildGone();
    }
  }, 60_000);
});
