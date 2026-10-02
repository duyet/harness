import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

// Plans 029 + 030: what every POST route hands back, and what it must not. Both
// projects are unauthenticated, so the response is bounded for the same reason
// the request is — and a bound that is not visibly a bound is just a short
// answer nobody can tell from a real one.
const RUNNER = new URL("./fixtures/gateway-response-projection-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

function writeConfig() {
  writeFileSync(
    join(fixture.cwd, ".herdr-harness.json"),
    JSON.stringify({
      adapters: { default: "fixture-adapter", routes: { "fixture-adapter": { kind: "fixture" } } },
      tasks: [{ id: "fixture-task", adapter: "fixture-adapter" }],
    }),
  );
}

// The runner asserts in its own process and reports what it measured; an
// assertion failure there is a nonzero exit, not a throw across the boundary.
function run(mode: string): Record<string, unknown> {
  const result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.mode).toBe(mode);
  return parsed;
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  writeConfig();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("ingress response projection (isolated; no sockets)", () => {
  test("every capped field on every task response carries its own flag", () => {
    // Plan 030 Vector B. The marker is checked on the wire, so this fails on an
    // echo as surely as on a missing `*Truncated`.
    expect(run("task-flags").cases).toBe(10);
  });

  test("an uncut answer on all five routes is byte-identical to before", () => {
    // Plan 024's constraint, kept as a literal: not the same keys, the same
    // bytes, on the three task routes and both issue routes.
    expect(run("verbatim-bytes").routes).toBe(5);
  });

  test("the issue-draft 202 carries no absolute path on either error route", () => {
    // Plan 029. The runner also asserts the draft is still on disk, still
    // contained, and still correlated by fingerprint, title, status, createdAt.
    expect(run("draft-projection").routes).toBe(2);
  });

  test("an oversized event_id is capped and flagged on the response, not on disk", () => {
    // Plan 030 Vector A. `storedFingerprintChars` is the load-bearing half: the
    // cap is on the reflection, and the draft's identity is still the whole id.
    const detail = run("draft-id");
    expect(detail.routes).toBe(2);
    expect(detail.storedFingerprintChars).toBe("proj-id-".length + 200 * 1024);
  });

  test("the capped fields are named in one list, not spread per field", () => {
    // The structural half of Vector B: a new capped field has one place to be
    // added, so the next one cannot come back unflagged on the response.
    expect(run("one-list").fields).toEqual(["channel", "sender", "taskId", "text"]);
  });
});
