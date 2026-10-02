import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/gateway-ingress-caps-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

// A task id long enough to prove the lookup key still resolves uncapped, well
// under the 512-char cap but far past any hand-written config id.
const LONG_TASK_ID = `long-task-${"z".repeat(300)}`;

function writeConfig() {
  writeFileSync(
    join(fixture.cwd, ".herdr-harness.json"),
    JSON.stringify({
      adapters: {
        default: "fixture-adapter",
        routes: { "fixture-adapter": { kind: "fixture" } },
      },
      tasks: [
        { id: "fixture-task", adapter: "fixture-adapter" },
        { id: LONG_TASK_ID, adapter: "fixture-adapter" },
      ],
    }),
  );
}

// The runner asserts the storage contract in its own process and reports back
// what it measured; an assertion failure there is a nonzero exit, not a throw
// across the boundary.
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

describe("ingress field caps (isolated; the socket case binds loopback only)", () => {
  test("ordinary matrix and telegram events store and project exactly as before", () => {
    // Anti-regression: no ordinary event gains a truncation flag, and the
    // /status projection keeps the fields the chat page reads.
    const detail = run("verbatim");
    expect(detail.marker).toBe("harness-ingress-cap-marker-4c1d9e");
  });

  test("an oversized matrix sender is capped, flagged and reports its real size", () => {
    const detail = run("sender");
    expect(detail.senderBytes).toBeGreaterThan(8 * 1024);
    expect(detail.projectedBytes).toBe(201);
  });

  test("an oversized telegram chat.id is capped and flagged", () => {
    const detail = run("channel");
    expect(detail.channelBytes).toBeGreaterThan(8 * 1024);
  });

  test("every taskId branch is capped, and a realistic id still resolves", () => {
    const detail = run("task-id");
    expect(detail.taskIdBytes).toBeNull();
    expect(detail.longIdLength).toBe(310);
  });

  test("every ingress source caps sender and text, and /status stays a few KB", () => {
    const detail = run("sources");
    const observed = detail.statusBytes as Array<{ path: string; statusBytes: number }>;
    expect(observed.map((o) => o.path)).toEqual([
      "/ingress/matrix",
      "/ingress/telegram",
      "/chat",
    ]);
    for (const entry of observed) {
      expect(entry.statusBytes, entry.path).toBeLessThan(4 * 1024);
    }
  });

  test("the POST responses project the task: bounded, flagged, and byte-identical when small", () => {
    // The return path, which the stored-event caps never reached.
    const detail = run("response");
    expect(detail.marker).toBe("harness-ingress-cap-marker-4c1d9e");
    const observed = detail.responseBytes as Array<{
      path: string;
      smallBytes: number;
      hugeBytes: number;
    }>;
    expect(observed.map((o) => o.path)).toEqual([
      "/ingress/matrix",
      "/ingress/telegram",
      "/chat",
    ]);
    for (const entry of observed) {
      expect(entry.hugeBytes, entry.path).toBeLessThan(4 * 1024);
      expect(entry.smallBytes, entry.path).toBeLessThan(4 * 1024);
    }
  });

  test("a declared oversized body is a 413 that writes nothing", () => {
    const detail = run("content-length");
    expect(detail.declared).toBe("262145");
    expect(detail.statusBytes).toBeLessThan(200);
  });

  test("a real server refuses an oversized body even with no Content-Length", { timeout: 30_000 }, () => {
    // Loopback socket against an ephemeral port: no sockets outside the
    // fixture, no network, and the gateway stopped before the runner exits.
    const detail = run("socket");
    expect(detail.portWasEphemeral).toBe(true);
  });
});
