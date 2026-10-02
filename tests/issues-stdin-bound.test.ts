import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/issues-stdin-runner.ts", import.meta.url).href;
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
let fixture: ReturnType<typeof createFixture>;

const EVENT = { event_id: "stdin-bound-1", project: "harness", message: "TypeError: boom", level: "error" };

// The pty probe runs under `$SHELL -c` via `script`, so paths need quoting.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Runs the real CLI with stdin forced to a terminal. Assertions happen in the
// test process because the refusal path ends in process.exit(1), which takes
// the runner with it.
function runTty(mode: "tty-stdin" | "tty-with-file") {
  fixture.assertIsolation();
  return fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
    await import(${JSON.stringify(RUNNER)});
  `);
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("issues ingest stdin is bounded", () => {
  test("a terminal is refused, not read, and the refusal is JSON with usage", () => {
    const result = runTty("tty-stdin");
    expect(result.exit, result.stderr).toBe(1);
    expect(result.stderr).not.toContain("harness-stdin-guard-did-not-answer");

    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("terminal");
    // The message has to be the usage, since this is the only place the
    // operator learns the subcommand wants a pipe.
    expect(body.error).toContain("--file");
    expect(body.error).toContain("stdin");
  });

  test("the refusal happens before the payload, so nothing is drafted", () => {
    runTty("tty-stdin");
    const drafts = join(fixture.home, ".local", "state", "herdr-harness", "issues");
    expect(existsSync(drafts)).toBe(false);
  });

  test("`--file` still works with a terminal attached", () => {
    const result = runTty("tty-with-file");
    expect(result.exit, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(true);
    expect(body.draft.fingerprint).toBe("stdin-guard-1");
  });

  test("a real terminal refuses at once instead of waiting on the stream", async () => {
    // The stub above forces the flag, but a property set on a /dev/null stdin
    // cannot demonstrate the hang itself — that read returns EOF immediately.
    // This drives a genuine character device and measures the child's own
    // elapsed time, with the pty's stdin deliberately held open for a few
    // seconds by a pipe that never closes. Measured against a build without
    // the guard, that read blocks for exactly as long as the operator's
    // terminal stays open, so the number below is the whole finding.
    if (Bun.spawnSync(["sh", "-c", "command -v script"]).exitCode !== 0) {
      console.warn("skipping real-pty check: util-linux `script` is unavailable");
      return;
    }
    fixture.assertIsolation();

    const HOLD_MS = 3000;
    // The timing echo comes last but must not become the shell's exit status:
    // `script -e` reports the status of the whole string, so carry the CLI's
    // own code out with an explicit exit.
    const probe = [
      "S=$(date +%s%N)",
      `${shellQuote(process.execPath)} ${shellQuote(CLI)} issues ingest --source sentry`,
      "RC=$?",
      'echo "__CHILD_MS=$(( ($(date +%s%N)-S)/1000000 ))"',
      "exit $RC",
    ].join("; ");

    const proc = Bun.spawn(["script", "-qec", probe, "/dev/null"], {
      cwd: fixture.cwd,
      env: fixture.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new Response(proc.stdout).text();
    const err = new Response(proc.stderr).text();
    const exited = proc.exited;

    // An unguarded CLI is still parked on the read when the hold expires; a
    // guarded one has already exited, so the passing case never waits.
    await Promise.race([exited, Bun.sleep(HOLD_MS)]);
    proc.stdin.end();
    expect(await exited, `child did not exit: ${await err}`).toBe(1);

    // `script` folds the child's stdout into the pty, so lines come back CRLF.
    const stdout = (await out).replace(/\r\n/g, "\n");
    const childMs = Number(stdout.match(/__CHILD_MS=(\d+)/)?.[1]);
    expect(childMs, `unreadable pty output: ${stdout}`).toBeGreaterThan(0);
    // The plan's criterion is under a second; without the guard this is HOLD_MS.
    expect(childMs, `cli waited ${childMs}ms on a terminal`).toBeLessThan(1000);

    const body = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.indexOf("__CHILD_MS")).trim());
    expect(body.ok).toBe(false);
    // Assert the guard's own message: an unguarded read that hits EOF reports
    // "empty payload", which also mentions --file and would pass a looser check.
    expect(body.error).toContain("terminal");
  });
});

describe("the bounded stdin paths are unchanged", () => {
  test("piped JSON still ingests", () => {
    fixture.assertIsolation();
    const result = fixture.runCli(["issues", "ingest", "--source", "sentry"], JSON.stringify(EVENT));
    expect(result.exit, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("dry-run");
    expect(body.draft.fingerprint).toBe("stdin-bound-1");
    expect(body.draft.path).toBe(
      join(fixture.home, ".local", "state", "herdr-harness", "issues", "sentry-stdin-bound-1.json"),
    );
  });

  test("`--file` still ingests, and never reads stdin", () => {
    fixture.assertIsolation();
    const dir = mkdtempSync(join(fixture.tmp, "payload-"));
    const file = join(dir, "event.json");
    writeFileSync(file, JSON.stringify(EVENT));

    // No stdin at all here: the helper hands the child /dev/null, so this
    // covers both "ignores stdin" and "does not need it".
    const result = fixture.runCli(["issues", "ingest", "--source", "sentry", "--file", file]);
    expect(result.exit, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(true);
    expect(body.draft.fingerprint).toBe("stdin-bound-1");
  });

  test("an empty pipe still reports the empty-payload error", () => {
    fixture.assertIsolation();
    const result = fixture.runCli(["issues", "ingest", "--source", "sentry"], "");
    expect(result.exit, result.stderr).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("empty payload");
  });

  test("the stored draft is the full payload, not a shell's echo of the guard", () => {
    // Cheap end-to-end: the guard is a stdin concern only and must not have
    // leaked into the draft path the plan left alone.
    fixture.assertIsolation();
    const result = fixture.runCli(["issues", "ingest", "--source", "bugsink"], JSON.stringify(EVENT));
    expect(result.exit, result.stderr).toBe(0);
    const path = JSON.parse(result.stdout).draft.path as string;
    expect(JSON.parse(readFileSync(path, "utf8")).source).toBe("bugsink");
  });
});
