import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

// Plan 033: `fingerprintFor`'s fallback hashed `JSON.stringify(raw).slice(0,
// 200)`, so two incidents agreeing through character 200 shared one
// `sentry-<key>.json` path — the second overwrote the first, and if the first
// had been published the second inherited its URL and status and was never
// filed, with the unauthenticated 202 reporting the outcome as published.
//
// The runner drives the real fingerprint / ingest / publish paths against a
// fixture `gh` in an isolated HOME/cwd; an assertion failure there is a nonzero
// exit, not a throw across the boundary.
const RUNNER = new URL("./fixtures/issues-fingerprint-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

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

describe("fingerprintFor covers the whole payload", () => {
  test("two id-less incidents sharing a 200-char prefix get different fingerprints", () => {
    const detail = run("fingerprints");
    const table = detail.table as { name: string; a: string; b: string }[];
    // Every case the plan names, and each one asserted by the runner to agree
    // through the cut and differ after it — so this table is a set of
    // regressions, not a set of coincidences.
    expect(table.map((row) => row.name).sort()).toEqual(["key-order", "last-byte", "long-stack"]);
    for (const row of table) {
      expect(row.a, `${row.name}: collapsed onto one fingerprint`).not.toBe(row.b);
      // Still a digest: `storageKeyFor`'s SAFE_KEY_RE allowlist relies on it.
      expect(row.a, `${row.name}: not a 16-char hex digest`).toMatch(/^[0-9a-f]{16}$/);
      expect(row.b, `${row.name}: not a 16-char hex digest`).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test("a surrogate pair straddling character 200 no longer collapses the pair", () => {
    const astral = run("fingerprints").astral as { a: string; b: string };
    // The old cut was on UTF-16 code units, so it could take the high half of a
    // surrogate pair and leave a lone one behind — a second way the same line
    // lost information about a real incident.
    expect(astral.a).not.toBe(astral.b);
  });

  test("narrowing the key does not widen it: one payload is still one fingerprint", () => {
    const detail = run("fingerprints");
    expect(detail.repeated).toMatch(/^[0-9a-f]{16}$/);
  });

  test("an event with an id is still keyed by that id, verbatim and whole", () => {
    // Plan 033's STOP condition: plans 023 and 030 are both built on the whole
    // id reaching storage, with the cap on the reflection instead.
    const detail = run("fingerprints");
    expect(detail.ids).toEqual({ event_id: "abc", eventId: "abc", id: "abc" });
    expect(detail.longIdFingerprint).toEqual({ length: 1003, idLength: 1003 });
  });
});

describe("id-less incidents each get their own draft", () => {
  test("ingesting two distinct incidents leaves two files and both bodies on disk", () => {
    const detail = run("ingest-pair");
    expect(detail.files as string[]).toHaveLength(2);
    expect(detail.fingerprints).toMatchObject({ a: expect.any(String), b: expect.any(String) });
    // The report that used to vanish: A's body still holds A's frame.
    expect(detail.aHasAlpha).toBe(true);
    expect(detail.aHasBeta).toBe(false);
    expect(detail.bHasBeta).toBe(true);
    expect(detail.bHasAlpha).toBe(false);
    expect(detail.statuses).toEqual(["mock-draft", "mock-draft"]);
  });

  test("publishing one incident does not suppress the next", () => {
    const detail = run("publish-arm");
    expect(detail.skipped).toBeNull();
    expect(detail.urlA).toBe("https://github.com/duyet/harness/issues/100");
    expect(detail.urlB).toBe("https://github.com/duyet/harness/issues/101");
    expect(detail.issueNumbers).toEqual([100, 101]);
    // Read off the fixture `gh`'s own record, not off what the harness reported.
    expect(detail.ghCalls).toBe(2);
    expect(detail.files as string[]).toHaveLength(2);
    // Neither draft is stamped published against the other's issue.
    expect(detail.statuses).toEqual(["github-created", "github-created"]);
    expect(detail.storedUrls).toEqual([
      "https://github.com/duyet/harness/issues/100",
      "https://github.com/duyet/harness/issues/101",
    ]);
  });
});