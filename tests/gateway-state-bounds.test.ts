import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/gateway-state-bounds-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

function writeConfig() {
  writeFileSync(
    join(fixture.cwd, ".herdr-harness.json"),
    JSON.stringify({
      adapters: {
        default: "fixture-adapter",
        routes: { "fixture-adapter": { kind: "fixture" } },
      },
      tasks: [{ id: "fixture-task", adapter: "fixture-adapter" }],
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

function cliJson(args: string[]) {
  const result = fixture.runCli(args);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  writeConfig();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("gateway ingress state bounds (isolated, no sockets)", () => {
  test("ordinary telegram and chat events are stored verbatim as before", () => {
    run("verbatim");
  });

  test("an oversized event caps body and text, reporting the original sizes", () => {
    const detail = run("oversized");
    expect(detail.originalBytes).toBeGreaterThan(64 * 1024);
    expect(detail.marker).toBe("harness-ingress-marker-8f3a2b");
  });

  test("/status projects lastDelivery and never echoes the delivery paths", () => {
    // Same unauthenticated route as lastEvent: the projected delivery carries
    // kind/at/bytes/excerpt and no path under STATE_DIR.
    const detail = run("delivery");
    expect(detail.projectionKeys).toEqual(["at", "bytes", "excerpt", "kind"]);
  });

  test("sixty large events leave the queue under budget and last-ingress small", () => {
    const detail = run("burst");
    expect(detail.queueBytes).toBeLessThan(2 * 1024 * 1024);
    expect(detail.lastBytes).toBeLessThan(8 * 1024);
  });

  test("the count window still drops the oldest events past 50", () => {
    // Same burst: with each event capped, 60 events hit the count window and
    // not the byte budget, so this isolates the 50-event behavior.
    expect(run("burst").queueBytes).toBeLessThan(2 * 1024 * 1024);
  });

  test("the queue byte budget evicts oldest events, keeping the newest", () => {
    const detail = run("budget-evict");
    expect(detail.kept).toBeGreaterThan(0);
    expect(detail.kept).toBeLessThan(50);
    expect(detail.queueBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  test("harness summary --json still exposes the stored event's truncation markers", () => {
    run("oversized");
    // The local detail path is untouched by the /status redaction: it reads
    // last-ingress.json from disk rather than the projected route response.
    const summary = cliJson(["summary", "--json"]);
    const last = summary.gatewayLastEvent;
    expect(last.bodyTruncated).toBe(true);
    expect(last.textTruncated).toBe(true);
    expect(last.bodyBytes).toBeGreaterThan(64 * 1024);
    expect(last.textBytes).toBeGreaterThan(200);
    expect(last.at).toBeTypeOf("string");
    expect(last.source).toBe("telegram");
  });
});