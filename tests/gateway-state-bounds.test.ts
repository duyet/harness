import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/gateway-state-bounds-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

function writeConfig(tasks: unknown[] = [{ id: "fixture-task", adapter: "fixture-adapter" }]) {
  writeFileSync(
    join(fixture.cwd, ".herdr-harness.json"),
    JSON.stringify({
      adapters: {
        default: "fixture-adapter",
        routes: { "fixture-adapter": { kind: "fixture" } },
      },
      tasks,
    }),
  );
}

// The runner asserts the storage contract in its own process and reports back
// what it measured; an assertion failure there is a nonzero exit, not a throw
// across the boundary.
function run(mode: string, payload?: string): Record<string, unknown> {
  const result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}, ${JSON.stringify(payload ?? "")}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.mode).toBe(mode);
  return parsed;
}

function cliJson(args: string[], exit = 0) {
  const result = fixture.runCli(args);
  expect(result.exit, result.stdout).toBe(exit);
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

// A state file only has to *parse* to reach a reader: `null`, `{}`, `[]`,
// `"x"` and `7` all come back from `JSON.parse`, so every one of them escaped
// the fallback that guards against a torn or corrupt file and arrived at the
// caller's `.push` / `.filter` as the wrong type.
const WRONG_SHAPES: Array<[string, string]> = [
  ["object", '{"not":"an array"}'],
  ["null", "null"],
  ["string", '"text"'],
  ["number", "7"],
  ["boolean", "true"],
  ["unparseable", "{"],
];

describe("wrong-shaped state files are not the caller's problem (isolated, no sockets)", () => {
  test("pick reports its normal answer instead of a stack trace", () => {
    // `tasks: []` and no drafts, so the freeform tier is the one actually
    // reached — that is where `queue.filter(...)` used to throw.
    writeConfig([]);
    for (const [label, bytes] of WRONG_SHAPES) {
      run("plant-queue", bytes);
      const pick = cliJson(["pick", "--json"], 1);
      expect(pick.ok, label).toBe(false);
      expect(pick.error, label).toBe("nothing to pick");
      expect(Array.isArray(pick.rules), label).toBe(true);
    }
  });

  test("a valid queue still rotates normally — the guard rejects nothing real", () => {
    writeConfig([]);
    const event = {
      at: new Date().toISOString(),
      source: "telegram",
      taskId: null,
      text: "a real freeform event",
      sender: "seed",
      channel: "0",
      freeform: true,
      route: null,
      body: { message: { text: "a real freeform event", chat: { id: 1 }, from: { username: "seed" } } },
    };
    run("plant-queue", JSON.stringify([event]));
    const pick = cliJson(["pick", "--json"]);
    expect(pick.ok).toBe(true);
    expect(pick.kind).toBe("freeform");
    expect(pick.id).toBe("freeform");
  });

  test("/chat answers a JSON envelope and repairs the queue", () => {
    for (const [label, bytes] of WRONG_SHAPES) {
      run("plant-queue", bytes);
      run("shape-chat", bytes);
    }
  });

  test("/status reads a last-ingress.json it cannot use as no last event", () => {
    for (const [label, bytes] of [...WRONG_SHAPES, ["array", "[]"]]) {
      run("plant-last", bytes);
      // Everything that is not a record reads as "no last event". `[]` is the
      // case that used to reach `projectEvent` whole, where `event.at` is
      // `Array.prototype.at` — a function, which JSON.stringify then drops,
      // so the projection came back as a half-built `{}`.
      if (label === "object") continue;
      expect(run("shape-status", bytes).lastEvent, label).toBe(null);
    }
    // `{}` is a record, so it keeps projecting — the same rule `lastDelivery`
    // has always applied. The contract is a JSON envelope either way.
    run("plant-last", "{}");
    expect(run("shape-status", "{}").lastEvent).toEqual({});
  });

  test("a wrong-shaped draft file is skipped, and the commands that read drafts still run", () => {
    // `{}` is a record, so it survives and is listed; the rest are not records
    // and are skipped. Both outcomes are in `listIssueDrafts`' contract.
    run("plant-drafts", JSON.stringify({
      "good.json": JSON.stringify({
        fingerprint: "good-fingerprint",
        title: "[sentry] fixture: good",
        source: "sentry",
        status: "mock-draft",
        createdAt: "2026-10-02T00:00:00.000Z",
      }),
      "empty-object.json": "{}",
      "null.json": "null",
      "string.json": '"text"',
      "array.json": "[]",
      "number.json": "7",
      "unparseable.json": "{",
    }));
    const listed = cliJson(["issues", "list"]);
    expect(listed.ok).toBe(true);
    expect(listed.count).toBe(2);
    expect(listed.drafts.map((d: { fingerprint?: string }) => d.fingerprint).sort()).toEqual([
      "good-fingerprint",
      undefined,
    ]);
    // `cmdPick` reads `.status`, `cmdSummary` reads `.fingerprint`; both take
    // the directory list through here, so neither may throw on the file. The
    // real draft is still the top pick, so the skip is selective.
    expect(cliJson(["summary", "--json"]).ok).toBe(true);
    const pick = cliJson(["pick", "--json"]);
    expect(pick.kind).toBe("issue");
    expect(pick.id).toBe("issue:good-fingerprint");
  });
});