import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Plan 033. Runs the real fingerprint / ingest / publish paths against a fixture
// `gh` in an isolated HOME/cwd, with a PATH that reaches nothing but the
// fixture bin. Never a real GitHub call, never the network.
const [mode, home, cwd] = process.argv.slice(2);
const MODES = new Set(["fingerprints", "ingest-pair", "publish-arm"]);
assert(MODES.has(mode), `bad mode: ${mode}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

const root = dirname(home);
const bin = join(root, "bin");
const capture = join(root, "gh-calls.json");
const ISSUES_DIR = join(home, ".local", "state", "herdr-harness", "issues");
const GH_BIN = join(bin, "gh");

// The prefix the old `slice(0, 200)` cut at. Every fixture below is built to
// agree through exactly this point, so under the old function every pair here
// hashed identically — that is what makes these tests a regression and not a
// table of coincidences.
const CUT = 200;

// A long shared stack. Real traces with a breadcrumb list run longer than this,
// and it is the ordinary shape of the vulnerable event: a stack, and no
// `event_id`, `message` or `title` anywhere.
const SHARED = [
  "TypeError: Cannot read properties of undefined (reading 'orderId')",
  "    at async Object.handler (app/api/orders.js:42:11)",
  "    at async processTicksAndRejections (node:internal/process/task_queues:95:5)",
  `    at async ${"wrapAsyncInner".repeat(30)}`,
].join("\n");

// The two incidents of the end-to-end arms. Distinct frames, same 200-char
// prefix: what an ordinary pair of alerts from one service looks like.
function stackEvent(frame: string): Record<string, unknown> {
  return {
    stack: `${SHARED}\n    at ${frame}`,
    culprit: "app/api/orders.js",
    level: "error",
    project: "harness",
  };
}
const EVENT_A = stackEvent("alpha/handler (orders.js:42)");
const EVENT_B = stackEvent("beta/handler (orders.js:42)");

function draftFiles(): string[] {
  if (!existsSync(ISSUES_DIR)) return [];
  return readdirSync(ISSUES_DIR).filter((f) => f.endsWith(".json")).sort();
}

// Read the bytes, not a parsed copy through `listIssueDrafts`: the question is
// what is actually on disk, and a reader that skipped a shape would be the very
// thing hiding it here.
function draftBytes(name: string): string {
  return readFileSync(join(ISSUES_DIR, name), "utf8");
}
function ghCalls(): unknown[] {
  return JSON.parse(readFileSync(capture, "utf8"));
}

// A recording `gh` that counts its own invocations, so "the second incident
// filed a second issue" is read off what the binary actually received rather
// than off what the harness reported.
mkdirSync(bin, { recursive: true });
if (!existsSync(capture)) writeFileSync(capture, "[]");
writeFileSync(
  GH_BIN,
  `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(capture, "utf8"));
const n = calls.length;
calls.push(args);
writeFileSync(capture, JSON.stringify(calls));
if (args[0] === "issue" && args[1] === "create") {
  console.log("https://github.com/duyet/harness/issues/" + (100 + n));
  process.exit(0);
}
console.error("unexpected fixture-gh args: " + args.join(" "));
process.exit(2);
`,
  { mode: 0o755 },
);
process.env.PATH = bin;

let detail: Record<string, unknown> = {};

if (mode === "fingerprints") {
  const { fingerprintFor } = await import("../../src/issues.ts");

  // The property, over a table: two distinct id-less / message-less /
  // title-less payloads that agree through the first 200 characters of their
  // serializations must not share a fingerprint.
  //
  // Each entry asserts its own precondition before reporting, so a fixture that
  // stopped being a regression case fails loudly instead of passing vacuously.
  const pairs: { name: string; a: Record<string, unknown>; b: Record<string, unknown> }[] = [
    // Two long stacks: the ordinary shape.
    { name: "long-stack", a: EVENT_A, b: EVENT_B },
    // Identical through character 200 and identical keys, ordered differently
    // after it. `JSON.stringify` preserves insertion order, so this is a real
    // input the endpoint accepts and a real difference a reader cannot see.
    {
      name: "key-order",
      a: { stack: SHARED, level: "error", culprit: "app/api/orders.js", alpha: 1, beta: 2 },
      b: { stack: SHARED, level: "error", culprit: "app/api/orders.js", beta: 2, alpha: 1 },
    },
    // One byte apart at the very end.
    {
      name: "last-byte",
      a: { stack: SHARED, level: "error", tail: "AAAA" },
      b: { stack: SHARED, level: "error", tail: "AAAB" },
    },
  ];

  const table = pairs.map(({ name, a, b }) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    // No id, no message, no title — or the id branch, not this fallback, is
    // what is under test.
    for (const key of ["event_id", "eventId", "id", "message", "title"]) {
      assert.equal(a[key], undefined, `${name}: fixture carries a ${key}`);
      assert.equal(b[key], undefined, `${name}: fixture carries a ${key}`);
    }
    assert(sa.length > CUT, `${name}: fixture is shorter than the cut it exists to straddle`);
    assert.equal(sa.slice(0, CUT), sb.slice(0, CUT), `${name}: fixtures must agree through ${CUT}`);
    assert.notEqual(sa, sb, `${name}: fixtures must differ after ${CUT}`);
    return { name, a: fingerprintFor(a), b: fingerprintFor(b) };
  });

  // The astral-plane case, independent of the collapse: the cut fell on UTF-16
  // code units, so it could land between the halves of a surrogate pair. The
  // filler puts the emoji's high surrogate at index 199 and its low surrogate at
  // 200 — exactly the pair the cut took in half.
  const astralFiller = "x".repeat(CUT - '{"stack":"'.length - 1);
  function astralEvent(frame: string): Record<string, unknown> {
    return { stack: `${astralFiller}😀${frame}`, level: "error" };
  }
  const astralA = astralEvent("alpha/handler");
  const astralB = astralEvent("beta/handler");
  const astralCut = JSON.stringify(astralA).slice(0, CUT);
  assert.equal(JSON.stringify(astralA).length > CUT, true);
  assert.equal(JSON.stringify(astralA).slice(0, CUT), JSON.stringify(astralB).slice(0, CUT));
  assert(
    /[\uD800-\uDBFF]$/.test(astralCut),
    "the fixture must leave a lone high surrogate at the cut, or it tests nothing",
  );

  // Plan 007's guard stands on the fingerprint being *stable*, so narrowing the
  // key must not widen it: the same event twice, and the same event rebuilt
  // from its own serialization, are one fingerprint.
  const repeated = fingerprintFor(EVENT_A);
  assert.equal(fingerprintFor({ ...EVENT_A }), repeated, "same payload, different fingerprint");
  assert.equal(fingerprintFor(JSON.parse(JSON.stringify(EVENT_A))), repeated);

  // And the STOP condition, pinned: an event that *has* an id is still keyed
  // by that id, verbatim and whole. Plans 023 and 030 are built on it.
  const longId = `fp-${"z".repeat(1000)}`;
  const ids: Record<string, unknown> = {};
  for (const key of ["event_id", "eventId", "id"]) {
    ids[key] = fingerprintFor({ [key]: "abc", message: "ignored" });
    assert.equal(ids[key], "abc", `${key} must be returned verbatim`);
  }
  assert.equal(fingerprintFor({ event_id: longId, message: "ignored" }), longId);
  assert.equal(fingerprintFor({ event_id: longId }).length, longId.length);
  // The id branch wins over a message and over the payload fallback alike.
  assert.equal(fingerprintFor({ event_id: "abc", message: "m", stack: SHARED }), "abc");
  // A message is still a usable key when there is no id.
  assert.notEqual(fingerprintFor({ message: "m1", culprit: "c" }), fingerprintFor({ message: "m2", culprit: "c" }));

  detail = {
    table,
    astral: { a: fingerprintFor(astralA), b: fingerprintFor(astralB) },
    repeated,
    ids,
    longIdFingerprint: { length: fingerprintFor({ event_id: longId }).length, idLength: longId.length },
  };
} else if (mode === "ingest-pair") {
  // End to end: ingest two distinct id-less incidents and check the directory
  // and the bytes, not the returned drafts.
  const { ingestErrorEvent } = await import("../../src/issues.ts");

  const draftA = ingestErrorEvent("sentry", EVENT_A);
  const draftB = ingestErrorEvent("sentry", EVENT_B);
  assert.notEqual(draftA.fingerprint, draftB.fingerprint, "the two incidents share a fingerprint");
  assert.notEqual(draftA.path, draftB.path);

  const files = draftFiles();
  assert.equal(files.length, 2, `expected two drafts, found ${files.join(", ")}`);

  const bytesA = draftBytes(files[0]!);
  const bytesB = draftBytes(files[1]!);
  detail = {
    files,
    fingerprints: { a: draftA.fingerprint, b: draftB.fingerprint },
    // Both frames present on disk, each in its own file: the first incident
    // was not overwritten by the second.
    aHasAlpha: bytesA.includes("alpha/handler"),
    aHasBeta: bytesA.includes("beta/handler"),
    bHasAlpha: bytesB.includes("alpha/handler"),
    bHasBeta: bytesB.includes("beta/handler"),
    statuses: [JSON.parse(bytesA).status, JSON.parse(bytesB).status],
  };
} else if (mode === "publish-arm") {
  // The published arm, and the one the plan calls unrecoverable: publish the
  // first incident, then deliver a *different* one. Under the old cut the
  // second inherited the first's issue URL and `github-created` status, so
  // plan 007's once-only guard skipped it forever while reporting `ok: true`.
  const { ingestErrorEvent, publishIssueDraft } = await import("../../src/issues.ts");

  const draftA = ingestErrorEvent("sentry", EVENT_A);
  const publishedA = publishIssueDraft(draftA, GH_BIN);
  assert.equal(publishedA.ok, true, publishedA.error ?? "gh did not file incident A");
  assert.equal(publishedA.status, 0);
  assert.equal(publishedA.draft.status, "github-created");
  assert.equal(ghCalls().length, 1);

  // The genuinely different alert, delivered afterwards.
  const draftB = ingestErrorEvent("sentry", EVENT_B);
  assert.equal(draftB.status, "mock-draft", "the second incident inherited the first's publication");
  assert.equal(draftB.githubIssueUrl, undefined);

  const publishedB = publishIssueDraft(draftB, GH_BIN);
  assert.equal(publishedB.skipped, undefined, "the second incident was suppressed as already-published");
  assert.equal(publishedB.ok, true, publishedB.error ?? "gh did not file incident B");
  assert.notEqual(publishedB.url, publishedA.url, "both incidents were filed against one issue");

  // And the record on disk says so, for both of them.
  const files = draftFiles();
  assert.equal(files.length, 2, `expected two drafts, found ${files.join(", ")}`);
  const stored = files.map((f) => JSON.parse(draftBytes(f)));
  detail = {
    files,
    urlA: publishedA.url,
    urlB: publishedB.url,
    issueNumbers: [publishedA.issueNumber, publishedB.issueNumber],
    skipped: publishedB.skipped ?? null,
    // gh really ran twice, from its own record rather than from what the
    // harness reported back.
    ghCalls: ghCalls().length,
    statuses: stored.map((d: { status: string }) => d.status).sort(),
    storedUrls: stored.map((d: { githubIssueUrl?: string }) => d.githubIssueUrl).sort(),
  };
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}

console.log(JSON.stringify({ ok: true, mode, ...detail }));