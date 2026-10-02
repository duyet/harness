import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the real ingest/publish paths against a fixture `gh` in an isolated
// HOME/cwd, with a PATH that reaches nothing but the fixture bin. Never a real
// GitHub call, never the network.
const [mode, home, cwd] = process.argv.slice(2);
const MODES = new Set([
  "verbatim", "idempotent", "oversized", "bounded-body", "count-bound", "byte-bound", "gh-missing",
  "gateway-202",
]);
assert(MODES.has(mode), `bad mode: ${mode}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

// Mirrors of the budgets in src/issues.ts; keep the two in step.
const PAYLOAD_MAX_BYTES = 96 * 1024;
const HEADER_MAX_CHARS = 500;
// posix_spawn refuses an argv element this long, which is what makes the cap a
// publishability bound rather than merely a storage bound.
const ARGV_MAX_BYTES = 128 * 1024;
const DIR_MAX_DRAFTS = 200;
const DIR_MAX_BYTES = 16 * 1024 * 1024;
// Finding either marker anywhere in a response or a stored draft means the
// payload escaped the cap.
const MARKER = "harness-issues-bound-marker-91ae";
const TAIL = "harness-issues-bound-tail-4d0f";

const root = dirname(home);
const bin = join(root, "bin");
const capture = join(root, "gh-calls.json");
const ISSUES_DIR = join(home, ".local", "state", "herdr-harness", "issues");

// A payload comfortably past the cap, with the distinctive runs at the tail so
// "the cap cut before them" and "they were never capped" differ.
function bigEvent(id: string, fillerKb: number) {
  return {
    event_id: id,
    project: "harness",
    message: "TypeError: boom",
    culprit: "src/cli.ts",
    level: "error",
    stack: `${"x".repeat(fillerKb * 1024)}${MARKER}${TAIL}`,
  };
}

// An oversized identifier in each of the three keys `fingerprintFor` reads, and
// a payload whose 2-space indent inflates it several-fold past the cap while its
// compact form stays inside it. The first shape used to write a 303 KB body and
// the last a 170 KB one that carried no truncation flag at all.
const ID_KEYS = ["event_id", "eventId", "id"] as const;
function oversizedId(key: (typeof ID_KEYS)[number]) {
  // The key name prefixes the id so the three shapes stay distinct drafts: an
  // identical id would make them one, and plan 007's published-once guard would
  // (correctly) refuse to spawn `gh` for the second and third.
  return {
    [key]: `bound-${key}-${"Z".repeat(200 * 1024)}`,
    project: "harness",
    message: "TypeError: boom",
    level: "error",
  };
}
function wideEvent(id: string) {
  return {
    event_id: id,
    project: "harness",
    message: "TypeError: boom",
    crumbs: Array.from({ length: 6554 }, () => ({ a: 1 })),
  };
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// The bodies plan 023 found and left alone, captured at `b661b4e`: a short
// ordinary event, and one carrying a long flat `stack`. Both are below the cap
// under every bound this plan adds, so they must not move by a byte. Recorded
// as digests because the second is 8 KB of filler.
const ORDINARY_BODY_SHA256 = "b624a74e1f96fe054c34643d505ca05f1658f75db81f80bdd8e37ce30e8ea971";
const FLAT_STACK_BODY_SHA256 = "c9c4ffffbf2f8a126ac6af0f9cb9eeb9aaddc3395e9d593c7bfe68d80c8fc469";

function draftFiles() {
  if (!existsSync(ISSUES_DIR)) return [];
  return readdirSync(ISSUES_DIR).filter((f) => f.endsWith(".json"));
}

function readDraft(name: string) {
  return JSON.parse(readFileSync(join(ISSUES_DIR, name), "utf8"));
}

function dirBytes() {
  return draftFiles().reduce((total, f) => total + statSync(join(ISSUES_DIR, f)).size, 0);
}

// Every mode but "gh-missing" gets a recording `gh` on a restricted PATH that
// prints an issue URL, so the publish path runs end to end offline.
if (mode !== "gh-missing") {
  mkdirSync(bin, { recursive: true });
  if (!existsSync(capture)) writeFileSync(capture, "[]");
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(capture, "utf8"));
const n = calls.length;
calls.push({ bodyBytes: Buffer.byteLength(args[args.indexOf("--body") + 1] ?? "", "utf8") });
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
}
process.env.PATH = mode === "gh-missing" ? join(root, "empty-bin") : bin;
if (mode === "gh-missing") mkdirSync(process.env.PATH, { recursive: true });

let detail: Record<string, unknown> = {};

if (mode === "verbatim") {
  // Case 1: an ordinary event produces today's draft exactly — no new field.
  const { ingestErrorEvent } = await import("../../src/issues.ts");
  const event = { event_id: "bound-ordinary-1", project: "harness", message: "TypeError: boom", level: "error" };
  const draft = ingestErrorEvent("sentry", event);
  assert.equal(draft.fingerprint, "bound-ordinary-1");
  assert.equal(draft.status, "mock-draft");
  assert.equal("bodyTruncated" in draft, false);
  assert.equal("bodyBytes" in draft, false);
  assert.equal("evicted" in draft, false);
  assert.deepEqual(draft.raw, event);
  // The JSON block in the body is still the pretty-printed event, untouched.
  assert(draft.body.includes(JSON.stringify(event, null, 2)), "ordinary body should stay pretty-printed");
  assert.equal(draft.title, "[sentry] harness: TypeError: boom");
  assert.deepEqual(draft.labels, ["mock", "sentry", "error", "desk:sentry-issues"]);

  // And it round-trips through the file unchanged.
  const stored = readDraft(`sentry-${"bound-ordinary-1"}.json`);
  assert.deepEqual(stored.raw, event);
  assert.equal("bodyTruncated" in stored, false);
  // The eviction report rides on the returned copy only, never on disk.
  assert.equal("evicted" in stored, false);
  detail = { bodyBytes: Buffer.byteLength(draft.body, "utf8") };
} else if (mode === "idempotent") {
  // Case 2: plan 007's published-once guard survives truncation. The event is
  // oversized so the draft is rebuilt truncated on every replay.
  const { ingestErrorEvent, publishIssueDraft, listIssueDrafts } = await import("../../src/issues.ts");
  const event = bigEvent("bound-idempotent-1", 512);
  const first = publishIssueDraft(ingestErrorEvent("sentry", event));
  assert.equal(first.ok, true);
  assert.equal(first.status, 0);
  assert.equal(first.url, "https://github.com/duyet/harness/issues/100");
  assert.equal(first.issueNumber, 100);
  assert.equal(first.draft.status, "github-created");
  assert.equal(first.draft.bodyTruncated, true);

  const name = `sentry-${"bound-idempotent-1"}.json`;
  const published = readDraft(name);
  assert.equal(published.status, "github-created");
  assert.equal(published.githubIssueUrl, "https://github.com/duyet/harness/issues/100");
  assert.equal(published.githubIssueNumber, 100);

  // The upstream replay: same oversized event_id, nothing spawns.
  const replay = publishIssueDraft(ingestErrorEvent("sentry", event));
  assert.equal(replay.ok, true);
  assert.equal(replay.skipped, "already-published");
  assert.deepEqual(replay.command, []);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).length, 1, "gh must be spawned once");

  // mergePublishedState still carries the recorded outcome across the rewrite.
  const after = readDraft(name);
  assert.equal(after.status, "github-created");
  assert.equal(after.githubIssueUrl, published.githubIssueUrl);
  assert.equal(after.githubIssueNumber, published.githubIssueNumber);
  assert.equal(after.createdAt, published.createdAt, "createdAt is when the issue was first seen");
  assert.equal(after.bodyTruncated, true, "the rebuilt draft is still visibly truncated");
  assert.equal(after.bodyBytes, published.bodyBytes);

  // A different event_id alongside it is unaffected.
  ingestErrorEvent("sentry", bigEvent("bound-idempotent-2", 8));
  assert.deepEqual(listIssueDrafts().map((d) => d.fingerprint).sort(), [
    "bound-idempotent-1", "bound-idempotent-2",
  ]);
  detail = { ghCalls: JSON.parse(readFileSync(capture, "utf8")).length };
} else if (mode === "oversized") {
  // Case 3: an oversized payload becomes a visibly truncated draft, and both
  // copies of the payload are inside the cap.
  const { ingestErrorEvent, githubIssueSpec, ghIssueCreateArgv } = await import("../../src/issues.ts");
  const event = bigEvent("bound-oversized-1", 2048);
  const serializedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  assert(serializedBytes > PAYLOAD_MAX_BYTES, "fixture must exceed the cap to be a test");

  const draft = ingestErrorEvent("sentry", event);
  assert.equal(draft.bodyTruncated, true);
  // The number describes what the draft kept — the bytes embedded in the body —
  // not the size of the event it was cut from. Both are worth knowing; only this
  // one is what `bodyBytes` means.
  assert.equal(draft.bodyBytes, PAYLOAD_MAX_BYTES);
  // The stored raw is a prefix, inside the bound, with the tail cut off.
  assert.equal(typeof draft.raw, "string");
  assert(Buffer.byteLength(draft.raw as string, "utf8") <= PAYLOAD_MAX_BYTES, "stored raw over budget");
  assert.equal((draft.raw as string).includes(TAIL), false, "stored raw should cut before the tail");
  assert.equal(draft.body.includes(TAIL), false, "embedded payload should cut before the tail");
  // The fingerprint still comes from the full payload, not the prefix.
  assert.equal(draft.fingerprint, "bound-oversized-1");

  // The argv body is bounded too — this is what `gh` could not accept before.
  const spec = githubIssueSpec(draft);
  const bodyBytes = Buffer.byteLength(spec.body, "utf8");
  assert(bodyBytes < ARGV_MAX_BYTES, `issue body ${bodyBytes} is past the single-argv limit`);
  const ghBody = ghIssueCreateArgv(draft)[ghIssueCreateArgv(draft).indexOf("--body") + 1]!;
  assert.equal(ghBody, spec.body);
  assert.equal(spec.title, draft.title);
  // Losing the mock note is the publish path's job, unchanged.
  assert.equal(spec.body.includes("mock — GitHub API not called"), false);
  assert.equal(spec.body.includes("created via gh issue create"), true);

  // Caller-controlled header values are bounded too, or a single huge `culprit`
  // would make the payload cap below unreachable by pushing the body over it
  // from the header lines alone. The JSON block still holds the event verbatim
  // here — this payload is under the cap — so the bound is checked on the
  // header lines, labels and title that are derived rather than embedded.
  const headered = ingestErrorEvent("sentry", {
    event_id: "bound-header-1",
    project: "p".repeat(4000),
    level: "error",
    culprit: "c".repeat(4000),
    message: "TypeError: boom",
  });
  const line = (label: string) =>
    headered.body.split("\n").find((l) => l.startsWith(`${label}: `))!;
  for (const label of ["Project", "Culprit"]) {
    assert(line(label).length <= 512, `${label} header line is ${line(label).length} chars`);
    assert(line(label).endsWith("…"), `${label} header line should show the cut`);
  }
  assert.equal(headered.title.length, 120);
  for (const label of headered.labels) {
    assert(label.length <= 501, `label ${label.length} chars`);
  }
  // Under the cap the event is stored whole, header bounds notwithstanding.
  assert.equal("bodyTruncated" in headered, false);

  // The bound that matters, at a size that used to be unbounded: a 2 MB event
  // stored twice was an 8.4 MB file.
  const storedBytes = statSync(draft.path!).size;
  assert(storedBytes <= 2 * PAYLOAD_MAX_BYTES + 8 * 1024, `draft file is ${storedBytes} bytes`);
  assert(storedBytes < serializedBytes, "the stored draft should be smaller than the event");
  detail = { serializedBytes, bodyBytes, storedBytes };
} else if (mode === "bounded-body") {
  // Case 4: the body fits the OS single-argv limit for *every* shape, asserted
  // as a property over a table rather than as one more fixture — so the next
  // field added to the header cannot silently reopen the hole. The first three
  // shapes are an oversized id in each key `fingerprintFor` reads; the last is
  // the payload that only the 2-space indent inflates past the cap.
  const { ingestErrorEvent, publishIssueDraft, githubIssueSpec } = await import("../../src/issues.ts");

  const shapes: { name: string; event: Record<string, unknown>; bigId: boolean }[] = [
    ...ID_KEYS.map((key) => ({ name: `oversized-${key}`, event: oversizedId(key), bigId: true })),
    { name: "wide-structured", event: wideEvent("bound-wide-1"), bigId: false },
  ];
  const bodies: Record<string, number> = {};
  for (const shape of shapes) {
    // The fixture must reproduce the hole, or the property below is vacuous.
    const compactBytes = Buffer.byteLength(JSON.stringify(shape.event), "utf8");
    assert(compactBytes > 32 * 1024, `${shape.name}: fixture is too small to be a test`);

    const draft = ingestErrorEvent("sentry", shape.event);
    const bodyBytes = Buffer.byteLength(draft.body, "utf8");
    assert(bodyBytes < ARGV_MAX_BYTES, `${shape.name}: body is ${bodyBytes} bytes`);
    bodies[shape.name] = bodyBytes;

    // A cut body says so, and the number is the size of what was embedded.
    assert.equal(draft.bodyTruncated, true, `${shape.name}: the cut is not visible on the draft`);
    assert.equal(typeof draft.raw, "string", `${shape.name}: the cut raw should be the embedded prefix`);
    assert.equal(draft.bodyBytes, Buffer.byteLength(draft.raw as string, "utf8"));
    assert(draft.body.includes(draft.raw as string), `${shape.name}: raw is not the embedded prefix`);
    // And the whole body is that payload plus a bounded header, so the header
    // can never be what pushes it over.
    assert(bodyBytes <= PAYLOAD_MAX_BYTES + 4 * (HEADER_MAX_CHARS + 32), `${shape.name}: header is unbounded`);

    // The fingerprint line is bounded, and shows the cut rather than hiding it.
    const fpLine = draft.body.split("\n").find((l) => l.startsWith("Fingerprint: "))!;
    assert(fpLine.length <= "Fingerprint: ".length + HEADER_MAX_CHARS + 1, `${shape.name}: ${fpLine.length} chars`);
    assert.equal(fpLine.endsWith("…"), shape.bigId, `${shape.name}: the cut should be visible`);
    // Identity is still the whole id: the body is bounded, the draft is not.
    assert.equal(draft.fingerprint, shape.event.event_id ?? shape.event.eventId ?? shape.event.id);
    assert.equal(draft.id, draft.fingerprint);

    // And it publishes: `gh` is reached, accepts the argv, and files the issue.
    const published = publishIssueDraft(draft);
    assert.equal(published.ok, true, `${shape.name}: ${published.error}`);
    assert.equal(published.status, 0);
    assert(published.url!.startsWith("https://github.com/duyet/harness/issues/"));
    assert.equal(published.draft.status, "github-created");
    // The recorded call is the argv `gh` actually received, not our own count.
    const calls = JSON.parse(readFileSync(capture, "utf8")) as { bodyBytes: number }[];
    assert.equal(calls.length, shapes.indexOf(shape) + 1, `${shape.name}: gh was not reached`);
    assert(calls[calls.length - 1].bodyBytes < ARGV_MAX_BYTES, `${shape.name}: argv body too long`);
    // The body `gh` is handed is rebuilt from the stored draft rather than
    // reused, so the bound has to hold on the rebuild too — and it differs from
    // the stored body only by the source note the publish path rewrites.
    const specBody = githubIssueSpec(draft).body;
    assert.equal(specBody, draft.body.split("mock — GitHub API not called").join("created via gh issue create"));
    assert(Buffer.byteLength(specBody, "utf8") < ARGV_MAX_BYTES, `${shape.name}: rebuilt body too long`);
  }

  // Ordinary drafts are byte-identical to before the bounds landed, or an
  // ordinary alert would read differently for no reason. Hashed rather than
  // spelled out: one is a short event, the other carries an 8 KB stack.
  const ordinary = { event_id: "bound-ordinary-1", project: "harness", message: "TypeError: boom", level: "error" };
  assert.equal(sha256(ingestErrorEvent("sentry", ordinary).body), ORDINARY_BODY_SHA256);
  assert.equal(sha256(ingestErrorEvent("sentry", bigEvent("bound-flat-1", 8)).body), FLAT_STACK_BODY_SHA256);
  // Neither carries the flags, so an ordinary draft's serialized shape is
  // unchanged too.
  assert.equal("bodyTruncated" in ingestErrorEvent("sentry", ordinary), false);

  detail = { bodies, ghCalls: JSON.parse(readFileSync(capture, "utf8")).length };
} else if (mode === "count-bound" || mode === "byte-bound") {
  // Cases 4 + 5: the directory stays inside its budget under sustained ingest,
  // evicting oldest `mock-draft` drafts only, and a `github-created` draft
  // survives every round.
  const { ingestErrorEvent, publishIssueDraft } = await import("../../src/issues.ts");

  // Published first, so it is the oldest file in the directory and the first
  // candidate the sweep would otherwise reach for.
  const publishedName = "sentry-bound-published.json";
  mkdirSync(ISSUES_DIR, { recursive: true });
  const published = publishIssueDraft(ingestErrorEvent("sentry", bigEvent("bound-published", 2)));
  assert.equal(published.ok, true);
  assert.equal(published.draft.status, "github-created");
  Bun.sleepSync(15); // keep mtimes strictly ordered

  // Distinct fillers so each mock draft has a different, checkable size.
  const fillerKb = mode === "byte-bound" ? 100 : 1;
  const rounds = mode === "byte-bound" ? DIR_MAX_BYTES / (fillerKb * 1024) + 8 : DIR_MAX_DRAFTS + 5;
  let evictedTotal = 0;
  let written = 0;
  for (let i = 0; i < rounds; i++) {
    const draft = ingestErrorEvent("sentry", bigEvent(`bound-fill-${mode}-${i}`, fillerKb));
    evictedTotal += draft.evicted?.length ?? 0;
    written = i;
    // The published draft is never a candidate, at any round.
    assert(existsSync(join(ISSUES_DIR, publishedName)), `published draft evicted at round ${i}`);
  }

  const files = draftFiles();
  const bytes = dirBytes();
  assert(files.length <= DIR_MAX_DRAFTS, `directory holds ${files.length} drafts`);
  assert(bytes <= DIR_MAX_BYTES, `directory holds ${bytes} bytes`);
  // The budget actually bound, rather than the loop simply not filling it.
  assert(evictedTotal > 0, "the bound never evicted anything");
  // Oldest first, and the newest survives. Filesystem timestamp granularity is
  // too coarse to separate every draft in a burst, so the sweep breaks ties by
  // name — which, with the zero-padded ids here, makes "oldest first" exact and
  // reproducible rather than dependent on directory read order.
  const survivors = files.filter((f) => f.startsWith("sentry-bound-fill-"));
  const lastRound = `sentry-bound-fill-${mode}-${written}.json`;
  assert.equal(survivors.includes(lastRound), true, `newest draft ${lastRound} was evicted`);
  assert.equal(survivors.includes(`sentry-bound-fill-${mode}-0.json`), false, "oldest draft survived");
  assert(survivors.length > 0 && survivors.length < rounds, "eviction did not free any room");
  // The published record still carries its outcome after every eviction round.
  const storedPublished = readDraft(publishedName);
  assert.equal(storedPublished.status, "github-created");
  assert.equal(storedPublished.githubIssueUrl, "https://github.com/duyet/harness/issues/100");
  assert.equal(storedPublished.githubIssueNumber, 100);
  detail = { drafts: files.length, bytes, evictedTotal, rounds };
} else if (mode === "gh-missing") {
  // Case 6, first half: a genuinely missing `gh` keeps its existing message.
  const { ingestErrorEvent, publishIssueDraft } = await import("../../src/issues.ts");
  const draft = ingestErrorEvent("sentry", bigEvent("bound-no-gh", 2));
  const result = publishIssueDraft(draft);
  assert.equal(result.ok, false);
  assert(result.error!.includes("gh not usable (gh)"), `got: ${result.error}`);
  assert.equal(result.error!.includes("E2BIG"), false);
  assert.equal(readDraft(`sentry-${"bound-no-gh"}.json`).status, "mock-draft");
  detail = { error: result.error };
} else if (mode === "gateway-202") {
  // Case 7: the /ingress/sentry 202 is bounded and still carries the fields a
  // caller needs to correlate the ingest.
  //
  // The two caps meet here, and the order matters: a payload past the request
  // ceiling is refused with 413 before it reaches the draft, so "oversized" for
  // this route means past ISSUE_PAYLOAD_MAX_BYTES but under the gateway's
  // request ceiling — the band where a real large alert lands and where the
  // draft is visibly truncated rather than refused. 150 KB sits in it.
  const { handleGatewayRequest } = await import("../../src/gateway.ts");
  const REQUEST_MAX_BYTES = 256 * 1024;
  const event = bigEvent("bound-gateway-1", 150);
  const serializedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  assert(serializedBytes > PAYLOAD_MAX_BYTES, "payload must exceed the draft cap");
  assert(serializedBytes < REQUEST_MAX_BYTES, "payload must stay under the request cap");

  const send = async (path: string, payload: Record<string, unknown>) =>
    handleGatewayRequest(
      new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(payload) }),
      { hostname: "127.0.0.1", port: 8787 },
    );

  const response = await send("/ingress/sentry", event);
  assert.equal(response.status, 202);
  const raw = await response.text();
  const body = JSON.parse(raw);
  assert.equal(body.ok, true);
  assert.equal(body.source, "sentry");
  const responseBytes = Buffer.byteLength(raw, "utf8");

  // Bounded: the payload is not echoed back, at any size.
  assert.equal(raw.includes(MARKER), false, "/ingress/sentry echoed the payload");
  assert.equal(raw.includes(TAIL), false, "/ingress/sentry echoed the payload");
  assert(responseBytes < 4 * 1024, `/ingress/sentry 202 was ${responseBytes} bytes`);

  // Still correlatable, and the truncation is visible rather than silent.
  assert.equal(body.draft.fingerprint, "bound-gateway-1");
  assert.equal(body.draft.id, "bound-gateway-1");
  assert.equal(body.draft.status, "mock-draft");
  assert.equal(body.draft.bodyTruncated, true);
  assert.equal(body.draft.bodyBytes, PAYLOAD_MAX_BYTES);
  // The projection never carries the payload itself.
  assert.equal("raw" in body.draft, false);
  assert.equal("body" in body.draft, false);
  // ...nor the absolute path (plan 029): it embeds $HOME and the OS username on
  // a route documented as unauthenticated. The stored copy still names it, so
  // containment is asserted there instead.
  assert.equal("path" in body.draft, false);
  const draftPath = join(ISSUES_DIR, "sentry-bound-gateway-1.json");

  // And the file on disk holds the whole bounded draft, containment intact.
  const stored = readDraft("sentry-bound-gateway-1.json");
  assert.equal(stored.path, draftPath);
  assert.equal(dirname(stored.path), ISSUES_DIR);
  assert.equal(stored.bodyTruncated, true);
  assert(Buffer.byteLength(stored.raw as string, "utf8") <= PAYLOAD_MAX_BYTES);

  // The other side of the boundary: past the request ceiling the route is a
  // 413 that writes nothing, so the band above is the only one that drafts.
  const refused = await send("/ingress/sentry", bigEvent("bound-gateway-2", 2048));
  assert.equal(refused.status, 413);
  assert.equal(existsSync(join(ISSUES_DIR, "sentry-bound-gateway-2.json")), false);

  // The draft stores the payload twice by design — embedded in `body` and
  // again as `raw` — so a capped draft costs about twice the cap, not twice
  // the input. Both copies are inside the bound, which is the point: an
  // uncapped 150 KB event would have written ~300 KB here, and the same event
  // at 2 MB wrote 8.4 MB before this cap existed.
  const storedBytes = statSync(draftPath).size;
  assert(storedBytes <= 2 * PAYLOAD_MAX_BYTES + 8 * 1024, `draft file is ${storedBytes} bytes`);

  // The second hole, reached the same unauthenticated way: a payload whose
  // compact form is inside the cap but whose 2-space-indented form is not. This
  // used to answer 202 with a ~170 KB draft carrying no truncation flag, so
  // nothing anywhere said the body could not be published.
  const wide = wideEvent("bound-gateway-wide");
  const wideCompact = Buffer.byteLength(JSON.stringify(wide), "utf8");
  const widePretty = Buffer.byteLength(JSON.stringify(wide, null, 2), "utf8");
  assert(wideCompact < PAYLOAD_MAX_BYTES, "wide fixture must be inside the cap as compact JSON");
  assert(widePretty > ARGV_MAX_BYTES, "wide fixture must overflow the argv limit once indented");
  assert(wideCompact < 256 * 1024, "wide fixture must stay reachable through the request ceiling");

  const wideResponse = await send("/ingress/sentry", wide);
  assert.equal(wideResponse.status, 202);
  const wideBody = JSON.parse(await wideResponse.text());
  assert.equal(wideBody.draft.fingerprint, "bound-gateway-wide");
  assert.equal(wideBody.draft.bodyTruncated, true, "the cut must be visible in the 202");
  assert.equal(wideBody.draft.bodyBytes, PAYLOAD_MAX_BYTES);
  assert.equal("body" in wideBody.draft, false);
  const wideDraft = readDraft("sentry-bound-gateway-wide.json");
  const wideBodyBytes = Buffer.byteLength(wideDraft.body, "utf8");
  assert(wideBodyBytes < ARGV_MAX_BYTES, `wide draft body is ${wideBodyBytes} bytes`);
  assert.equal(Buffer.byteLength(wideDraft.raw as string, "utf8"), PAYLOAD_MAX_BYTES);

  // Every fixture above oversizes a field the *payload* cap already bounds, so
  // none of them could have caught the response echoing an unbounded one. This
  // is the field that is not bounded there: `fingerprintFor` returns the
  // caller's `event_id` verbatim — it is the draft's identity, so it must — and
  // `projectIssueDraft` copied it, making a 200 KB POST answer with ~400 KB.
  // The reflection is now capped and says so; the stored identity is not.
  const bigId = `bound-gateway-big-id-${"Z".repeat(200 * 1024)}`;
  const idEvent = {
    event_id: bigId,
    project: "harness",
    message: "TypeError: boom",
    level: "error",
  };
  assert(
    Buffer.byteLength(JSON.stringify(idEvent), "utf8") < 256 * 1024,
    "oversized-id fixture must stay under the request ceiling",
  );

  const idResponse = await send("/ingress/sentry", idEvent);
  assert.equal(idResponse.status, 202);
  const idRaw = await idResponse.text();
  const idBody = JSON.parse(idRaw);
  const idResponseBytes = Buffer.byteLength(idRaw, "utf8");
  assert(idResponseBytes < 4 * 1024, `oversized event_id answered with ${idResponseBytes} bytes`);
  assert.equal(idRaw.includes("Z".repeat(1000)), false, "/ingress/sentry echoed the id");
  assert.equal(idBody.draft.fingerprint, `${bigId.slice(0, HEADER_MAX_CHARS)}…`);
  assert.equal(idBody.draft.id, idBody.draft.fingerprint);
  assert.equal(idBody.draft.fingerprintTruncated, true);
  assert.equal(idBody.draft.fingerprintBytes, Buffer.byteLength(bigId, "utf8"));
  assert.equal(idBody.draft.idTruncated, true);
  assert.equal(idBody.draft.idBytes, Buffer.byteLength(bigId, "utf8"));
  // The same event on the sibling route, so the cap is the projection's and not
  // one route's.
  const bugsinkResponse = await send("/ingress/bugsink", idEvent);
  assert.equal(bugsinkResponse.status, 202);
  const bugsinkRaw = await bugsinkResponse.text();
  assert(Buffer.byteLength(bugsinkRaw, "utf8") < 4 * 1024, "/ingress/bugsink echoed the id");
  const bugsinkDraft = JSON.parse(bugsinkRaw).draft;
  assert.equal(bugsinkDraft.fingerprintTruncated, true);
  assert.equal(bugsinkDraft.fingerprint, idBody.draft.fingerprint);

  // And the draft on disk still holds the whole id: two events sharing a
  // 500-char prefix cannot collapse onto one draft, which is exactly why the
  // cap is on the reflection and never inside `fingerprintFor`.
  const { listIssueDrafts } = await import("../../src/issues.ts");
  const idDraft = listIssueDrafts().find((d) => d.fingerprint === bigId);
  assert(idDraft, "the oversized-id draft is on disk under its full fingerprint");
  assert.equal(idDraft.fingerprint.length, bigId.length);
  assert.equal(idDraft.id, bigId);
  assert(dirname(idDraft.path!) === ISSUES_DIR, "the oversized-id draft stays contained");

  detail = { responseBytes, storedBytes, serializedBytes, idResponseBytes };
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}

console.log(JSON.stringify({ ok: true, mode, ...detail }));
