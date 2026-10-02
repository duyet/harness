import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spyOn } from "bun:test";

const [mode, home, cwd] = process.argv.slice(2);
const MODES = new Set(["task-flags", "verbatim-bytes", "draft-projection", "draft-id", "one-list"]);
assert(MODES.has(mode), `bad mode: ${mode}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

// Mirrors of the budgets in src/gateway.ts; keep the two in step.
const TEXT_MAX_CHARS = 200;
const SENDER_MAX_CHARS = 200;
const CHANNEL_MAX_CHARS = 200;
const TASK_ID_MAX_CHARS = 512;
const DRAFT_ID_MAX_CHARS = 500;
const REQUEST_MAX_BYTES = 256 * 1024;
const PAYLOAD_MAX_BYTES = 96 * 1024;

// Finding either marker in a response means an uncapped value leaked through.
const MARKER = "harness-response-cap-marker-7b3e";
const TAIL = "harness-response-cap-tail-2a9c";

const unexpected = (name: string): never => {
  throw new Error(`Unexpected side effect: ${name}`);
};
spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
// Bun's `typeof fetch` is the call signature plus a non-standard `preconnect`,
// so a bare arrow is not a fetch. This stub refuses both, as it always has.
spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(() => unexpected("fetch"), { preconnect: () => unexpected("fetch") }),
);

const { STATE_DIR, ISSUES_DIR } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const { handleGatewayRequest } = await import("../../src/gateway.ts");
const bind = { hostname: "127.0.0.1", port: 8787 };

// The POST, kept as bytes: a bound is a statement about size and a
// byte-identity claim is a statement about bytes, and a parsed object shows
// neither.
async function postRaw(path: string, body: Record<string, unknown>) {
  const response = await handleGatewayRequest(
    new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }),
    bind,
  );
  assert.equal(response.status, path === "/chat" ? 200 : 202, path);
  const raw = await response.text();
  const json = JSON.parse(raw) as Record<string, any>;
  assert.equal(json.ok, true, path);
  return { json, raw, bytes: Buffer.byteLength(raw, "utf8") };
}

const big = (head: string, size: number) => `${head}${"x".repeat(size)}${MARKER}${TAIL}`;
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

// The body that puts one oversized value on one route and nothing else, so a
// failing assertion names the field rather than the request. Every route keeps
// its ordinary sender and channel; the field under test replaces one.
function bodyWith(path: string, field: string, value: string): Record<string, unknown> {
  const text = field === "text" ? value : "hello there";
  if (path === "/ingress/matrix") {
    return {
      content: { body: text },
      sender: field === "sender" ? value : "@bob:example.org",
      room_id: field === "channel" ? value : "!room:example.org",
      ...(field === "taskId" ? { taskId: value } : {}),
    };
  }
  if (path === "/ingress/telegram") {
    return {
      message: {
        text,
        chat: { id: field === "channel" ? value : 5 },
        from: { username: field === "sender" ? value : "alice" },
      },
      ...(field === "taskId" ? { task_id: value } : {}),
    };
  }
  return { text, ...(field === "taskId" ? { taskId: value } : {}) };
}

const CAP_FOR: Record<string, number> = {
  text: TEXT_MAX_CHARS,
  sender: SENDER_MAX_CHARS,
  channel: CHANNEL_MAX_CHARS,
  taskId: TASK_ID_MAX_CHARS,
};

// The flag pair is named after the *event* field, but the task projection calls
// the same value `id` — the two names are why "silently shortened" went
// unnoticed, so the table says which is which rather than assuming.
const KEY_IN_TASK: Record<string, string> = {
  text: "text",
  sender: "sender",
  channel: "channel",
  taskId: "id",
};

// Which of the four capped fields each route actually takes from the caller.
// `/chat` names itself rather than reading `sender`, so an oversized `sender`
// there is discarded rather than cut — the same fact the stored-event cap
// runner already holds, repeated here because this table is about the response.
const CARRIES: Record<string, string[]> = {
  "/ingress/matrix": ["text", "sender", "channel", "taskId"],
  "/ingress/telegram": ["text", "sender", "channel", "taskId"],
  "/chat": ["text", "taskId"],
};

let detail: Record<string, unknown> = {};

if (mode === "task-flags") {
  // Plan 030 Vector B: the response carried `textTruncated` and nothing else,
  // so a `taskId` cut at 513 characters, a `sender` cut at 201 and a `channel`
  // cut at 201 all arrived silently shortened in the same object that flagged
  // its neighbour. Every capped field must now carry its own pair.
  const table: Array<{ path: string; field: string; value: string }> = [];
  for (const [path, fields] of Object.entries(CARRIES)) {
    for (const field of fields) {
      // Past every cap, under the request ceiling, with the marker at the tail
      // so "the cap cut before it" and "it was never capped" differ.
      table.push({ path, field, value: big(`${field}-`, 8 * 1024) });
    }
  }
  for (const { path, field, value } of table) {
    const answer = await postRaw(path, bodyWith(path, field, value));
    const cap = CAP_FOR[field]!;
    const where = `${path} ${field}`;
    assert.equal(answer.json.task[KEY_IN_TASK[field]!], `${value.slice(0, cap)}…`, where);
    assert.equal(answer.json.task[`${field}Truncated`], true, `${where}: no truncation flag`);
    assert.equal(answer.json.task[`${field}Bytes`], byteLength(value), `${where}: wrong byte count`);
    // The pair is the whole contract: the answer is bounded, and the marker
    // that would prove an echo is nowhere in it.
    assert(answer.bytes < 4 * 1024, `${where}: ${answer.bytes} bytes back`);
    assert.equal(answer.raw.includes(MARKER), false, `${where}: echoed the payload`);
    assert.equal(answer.raw.includes(TAIL), false, `${where}: echoed the payload`);
    // Only the field under test is flagged. This is the property that a
    // dropped entry in the list breaks first.
    for (const other of ["text", "sender", "channel", "taskId"]) {
      if (other === field || !CARRIES[path]!.includes(other)) continue;
      assert.equal(`${other}Truncated` in answer.json.task, false, `${where}: ${other} spuriously flagged`);
    }
    // /chat carries the text a second time inside the interpolated stub reply.
    if (path === "/chat" && field === "text") {
      assert.equal(answer.json.reply.includes(MARKER), false, "/chat: reply echoed the payload");
      assert.equal(answer.json.reply, `stub: freeform via fixture-adapter — ${value.slice(0, cap)}…`);
    }
  }
  detail = { cases: table.length };
} else if (mode === "verbatim-bytes") {
  // Plan 024's constraint, held as a literal: an uncut answer is byte-for-byte
  // what it was before this projection existed. Both timestamps are replaced
  // by a token, so every other byte is compared exactly.
  const TS = "<TIMESTAMP>";
  const stamp = (raw: string) =>
    raw.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, TS);
  const queuedAfter = { "/ingress/matrix": 1, "/ingress/telegram": 2, "/chat": 3 };
  const expected: Record<string, string> = {
    "/ingress/matrix":
      `{"ok":true,"source":"matrix","queued":${queuedAfter["/ingress/matrix"]},` +
      `"task":{"id":null,"text":"hello there","sender":"@bob:example.org",` +
      `"channel":"!room:example.org","adapterId":"fixture-adapter","freeform":true},` +
      `"route":null,"lastEvent":"${TS}"}`,
    "/ingress/telegram":
      `{"ok":true,"source":"telegram","queued":${queuedAfter["/ingress/telegram"]},` +
      `"task":{"id":null,"text":"hello there","sender":"alice","channel":"5",` +
      `"adapterId":"fixture-adapter","freeform":true},"route":null,"lastEvent":"${TS}"}`,
    "/chat":
      `{"ok":true,"mode":"stub","reply":"stub: freeform via fixture-adapter — hello there",` +
      `"adapterId":"fixture-adapter","task":{"id":null,"text":"hello there","sender":"chat-ui",` +
      `"channel":"local","adapterId":"fixture-adapter","freeform":true},"route":null,` +
      `"lastEvent":"${TS}","queued":${queuedAfter["/chat"]}}`,
  };
  for (const path of ["/ingress/matrix", "/ingress/telegram", "/chat"]) {
    const answer = await postRaw(path, bodyWith(path, "text", "hello there"));
    // The ordinary case adds no key at all: `textTruncated` / `textBytes` and
    // the three other pairs are absent, not false.
    for (const field of ["text", "sender", "channel", "taskId"]) {
      assert.equal(`${field}Truncated` in answer.json.task, false, `${path}: ${field} flag on an uncut answer`);
    }
    assert.equal(stamp(answer.raw), expected[path], path);
  }

  // The two issue routes, same rule: an ordinary draft's answer is exactly the
  // projection — including the `path` key plan 029 removed, which is why this
  // literal is written after 030 and 029 and pins both at once.
  const draftEvent = {
    event_id: "resp-1",
    project: "harness",
    message: "TypeError: boom",
    culprit: "src/cli.ts",
    level: "error",
  };
  for (const [path, source] of [["/ingress/sentry", "sentry"], ["/ingress/bugsink", "bugsink"]] as const) {
    const answer = await postRaw(path, draftEvent);
    assert.equal(
      stamp(answer.raw),
      `{"ok":true,"source":"${source}","queued":true,"draft":{` +
        `"id":"resp-1","fingerprint":"resp-1","title":"[${source}] harness: TypeError: boom",` +
        `"source":"${source}","playbook":"desk:sentry-issues",` +
        `"labels":["mock","${source}","error","desk:sentry-issues"],` +
        `"status":"mock-draft","createdAt":"${TS}"}}`,
      path,
    );
    // No cap was reached, so neither response cap nor the 029 removal adds a key.
    assert.equal("idTruncated" in answer.json.draft, false, path);
    assert.equal("fingerprintTruncated" in answer.json.draft, false, path);
  }
  detail = { routes: 5 };
} else if (mode === "draft-projection") {
  // Plan 029: the 202 is unauthenticated, and `path` is an absolute path under
  // $HOME that embeds the OS username. Plan 017 removed exactly these fields
  // from `projectDelivery` and never applied the rule here.
  for (const path of ["/ingress/sentry", "/ingress/bugsink"]) {
    const answer = await postRaw(path, { event_id: "proj-1", message: "TypeError: boom" });
    const draft = answer.json.draft;
    assert.equal("path" in draft, false, `${path}: the absolute draft path is back on the wire`);
    // The projection rule `projectDelivery` states: keep what identifies the
    // delivery and its size, drop the filesystem layout.
    for (const key of ["fingerprint", "title", "status", "createdAt"]) {
      assert(key in draft, `${path}: dropped ${key}, which the projection promises`);
    }
    assert.equal(draft.status, "mock-draft", path);
    assert.equal(draft.fingerprint, "proj-1", path);
    // The file is still where it was, and the local reader still finds it: only
    // the network answer lost the path.
    const files = readdirSync(ISSUES_DIR);
    assert(files.includes(`${path.split("/").pop()}-proj-1.json`), `${path}: the draft is not on disk`);
    const stored = JSON.parse(readFileSync(join(ISSUES_DIR, `${path.split("/").pop()}-proj-1.json`), "utf8"));
    assert.equal(stored.path, join(ISSUES_DIR, `${path.split("/").pop()}-proj-1.json`), path);
  }
  detail = { routes: 2 };
} else if (mode === "draft-id") {
  // Plan 030 Vector A: `fingerprintFor` returns the caller's `event_id`
  // verbatim — correctly, since the whole id is the draft's identity — and
  // `projectIssueDraft` copied it, so a 200 KB id made a 200 KB POST answer
  // with 400 KB. The reflection is capped and flagged; the stored identity is
  // not.
  const bigId = `proj-id-${"Z".repeat(200 * 1024)}`;
  for (const [path, source] of [["/ingress/sentry", "sentry"], ["/ingress/bugsink", "bugsink"]] as const) {
    const id = bigId;
    const body = { event_id: id, project: "harness", message: "TypeError: boom", level: "error" };
    assert(byteLength(JSON.stringify(body)) < REQUEST_MAX_BYTES, `${path}: fixture must be reachable`);
    const answer = await postRaw(path, body);
    const draft = answer.json.draft;
    const where = `${path}: `;
    assert(answer.bytes < 4 * 1024, `${where}${answer.bytes} bytes back for a ${byteLength(id)}-byte id`);
    assert.equal(answer.raw.includes("Z".repeat(1000)), false, `${where}echoed the id`);
    const capped = `${id.slice(0, DRAFT_ID_MAX_CHARS)}…`;
    assert.equal(draft.fingerprint, capped, where);
    assert.equal(draft.id, capped, where);
    assert.equal(draft.fingerprintTruncated, true, where);
    assert.equal(draft.fingerprintBytes, byteLength(id), where);
    assert.equal(draft.idTruncated, true, where);
    assert.equal(draft.idBytes, byteLength(id), where);
    // Two independent bounds land on the same answer: the 200 KB id is capped
    // as a reflection, and the event is past the payload cap so the body is cut
    // and says so. Neither substitutes for the other.
    assert.equal(draft.title, `[${source}] harness: TypeError: boom`, where);
    assert.equal(draft.bodyTruncated, true, where);
    assert.equal(draft.bodyBytes, PAYLOAD_MAX_BYTES, where);
  }

  // Draft identity, asserted rather than assumed: the whole id still reaches
  // storage, so two events sharing a 500-char prefix cannot collapse onto one
  // draft — which is what capping inside `fingerprintFor` would have done.
  const { listIssueDrafts, fingerprintFor } = await import("../../src/issues.ts");
  const stored = listIssueDrafts();
  assert.equal(stored.length, 2, "both oversized-id drafts are on disk, as separate drafts");
  for (const draft of stored) {
    assert.equal(draft.fingerprint, bigId, "the stored fingerprint is the whole id");
    assert.equal(draft.fingerprint, fingerprintFor({ event_id: bigId }), "identity unchanged");
    assert.equal(draft.id, bigId, "the stored id is the whole id");
    // A 200 KB id is not a legal filename, so the storage key is the encoded
    // namespace — the draft is still one file per fingerprint, not one per
    // 500-char prefix.
    assert.equal(dirname(draft.path!), ISSUES_DIR, "still contained");
    assert(
      basename(draft.path!).startsWith(`${draft.source}-~`),
      `not the encoded namespace: ${draft.path}`,
    );
  }
  // A small id is untouched, and carries no flag: nothing is flagged for free.
  const small = await postRaw("/ingress/sentry", { event_id: "proj-small", message: "boom" });
  assert.equal(small.json.draft.fingerprint, "proj-small");
  assert.equal("fingerprintTruncated" in small.json.draft, false);
  assert.equal("idTruncated" in small.json.draft, false);
  detail = { routes: 2, storedFingerprintChars: stored[0]!.fingerprint.length };
} else if (mode === "one-list") {
  // The "one list, not four ad-hoc spreads" half of Vector B, pinned in the
  // source rather than only in behaviour: `CAPPED_FIELDS` is what a new capped
  // field has to be added to, so it must name every capped field the event
  // type declares — and a projection that spread per-field flags again would
  // satisfy no such check.
  const gatewaySource = readFileSync(new URL("../../src/gateway.ts", import.meta.url), "utf8");
  const declared = gatewaySource.match(/const CAPPED_FIELDS = \[([^\]]*)\]/)?.[1];
  assert(declared, "CAPPED_FIELDS is not a literal list any more");
  const names = [...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
  // Every optional `*Truncated` field on IngressEvent except the body's, which
  // `capBody` owns and which is not one of the four normalised values.
  const flagFields = [...gatewaySource.matchAll(/^ {2}(\w+Truncated)\?:/gm)].map((m) => m[1]!);
  const normalised = flagFields
    .map((f) => f.replace(/Truncated$/, ""))
    .filter((f) => f !== "body")
    .sort();
  assert.deepEqual(names, normalised, `CAPPED_FIELDS must cover exactly ${normalised.join(", ")}`);
  assert.deepEqual(names, ["channel", "sender", "taskId", "text"]);
  // The per-field flag helper is gone, so the next capped field has one place
  // to be added rather than one per response surface.
  assert.equal(/function capFlags</.test(gatewaySource), false, "the per-field flag helper is back");
  assert.equal(/\.\.\.capText\(/.test(gatewaySource), false, "an ad-hoc capText spread is back");
  detail = { fields: names };
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}

console.log(JSON.stringify({ ok: true, mode, ...detail }));
