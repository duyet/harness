import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/issues-bounds-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

// The byte-bound case writes ~16 MB of drafts on purpose; give it room.
const SLOW_MS = 120_000;

// The runner drives the real ingest/publish paths against a fixture `gh` in an
// isolated HOME/cwd and asserts the storage contract in its own process; an
// assertion failure there is a nonzero exit, not a throw across the boundary.
function run(mode: string): Record<string, unknown> {
  fixture.assertIsolation();
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
});

afterEach(() => {
  fixture?.cleanup();
});

describe("issue draft payload bounds", () => {
  test("an ordinary sentry event produces today's draft with no truncation flags", () => {
    const detail = run("verbatim");
    expect(detail.bodyBytes).toBeLessThan(1024);
  });

  test("plan 007's published-once guard still holds for a truncated draft", () => {
    const detail = run("idempotent");
    expect(detail.ghCalls).toBe(1);
  });

  test("an oversized payload is truncated, flagged, and stored inside the cap", () => {
    const detail = run("oversized");
    expect(detail.serializedBytes).toBeGreaterThan(96 * 1024);
    // The issue body gh would receive stays under the OS single-argv limit.
    expect(detail.bodyBytes).toBeLessThan(128 * 1024);
    // And the draft file is bounded even though the payload is stored twice.
    expect(detail.storedBytes as number).toBeLessThan((detail.serializedBytes as number) * 0.5);
  });

  test("every draft shape stays publishable, not just the ones the fixture wrote", () => {
    const detail = run("bounded-body");
    // One gh call per shape: each reached the binary and was accepted, rather
    // than failing to spawn on an argument list past the OS limit.
    expect(detail.ghCalls).toBe(4);
    const bodies = detail.bodies as Record<string, number>;
    expect(Object.keys(bodies).sort()).toEqual([
      "oversized-eventId",
      "oversized-event_id",
      "oversized-id",
      "wide-structured",
    ]);
    for (const [name, bytes] of Object.entries(bodies)) {
      expect(bytes, `${name} body is ${bytes} bytes`).toBeLessThan(128 * 1024);
    }
    // The shapes that used to break are the ones that stay wide: an oversized
    // id in any of the three keys, and a payload the indent alone inflates.
    expect(Math.max(...Object.values(bodies))).toBeGreaterThan(96 * 1024);
  });

  test("a missing gh still reports gh not usable, not an argument-limit failure", () => {
    const detail = run("gh-missing");
    expect(String(detail.error)).toContain("gh not usable (gh)");
    expect(String(detail.error)).not.toContain("E2BIG");
  });
});

describe("issues directory bounds", { timeout: SLOW_MS }, () => {
  test("sustained ingest past the count cap evicts oldest mock drafts only", () => {
    const detail = run("count-bound");
    expect(detail.rounds).toBe(205);
    expect(detail.drafts as number).toBeLessThanOrEqual(200);
    expect(detail.evictedTotal as number).toBeGreaterThan(0);
  });

  test("sustained ingest past the byte cap stays inside the budget", () => {
    const detail = run("byte-bound");
    expect(detail.bytes as number).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(detail.evictedTotal as number).toBeGreaterThan(0);
    // A github-created draft survived every round; the runner asserts its
    // status and recorded issue URL are still on disk.
    expect(detail.drafts as number).toBeGreaterThan(0);
  });
});

describe("error ingress response", () => {
  test("the /ingress/sentry 202 is bounded and carries fingerprint and path", () => {
    const detail = run("gateway-202");
    expect(detail.responseBytes as number).toBeLessThan(4 * 1024);
    // The payload is stored twice in the draft, so the file costs about twice
    // the cap however large the request was.
    expect(detail.storedBytes as number).toBeLessThanOrEqual(2 * 96 * 1024 + 8 * 1024);
  });
});
