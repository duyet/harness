import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ISSUES_DIR, PLAYBOOK_SENTRY, writeJsonAtomic } from "./shared.ts";

export type IssueDraft = {
  id: string;
  title: string;
  body: string;
  labels: string[];
  source: "sentry" | "bugsink";
  playbook: typeof PLAYBOOK_SENTRY;
  fingerprint: string;
  createdAt: string;
  status: "mock-draft" | "github-created";
  githubIssueUrl?: string;
  githubIssueNumber?: number;
  path?: string;
  raw?: unknown;
  // Set only when the body was cut at ISSUE_PAYLOAD_MAX_BYTES. An ordinary
  // draft carries neither, so its serialized shape is unchanged; a draft
  // written before the cap existed simply lacks them. `bodyBytes` is the size
  // of the payload actually embedded in `body`, not the size of the event it
  // came from — the pair describes what the draft kept, which is what a reader
  // of the body needs to know.
  bodyTruncated?: boolean;
  bodyBytes?: number;
  // Reported on the copy `writeIssueDraft` returns, never written to the file:
  // which drafts the directory bound evicted during this write.
  evicted?: string[];
};

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

// The id branch returns the caller's identifier verbatim, because the id *is*
// the draft's identity — plans 023 and 030 both depend on the whole of it
// reaching storage.
//
// The fallback hashes the **whole** serialized payload, and plan 033 is what
// made that true. It used to be `JSON.stringify(raw).slice(0, 200)`, which is
// not a bound but a collision: two incidents that agree through character 200
// hashed identically, shared one `sentry-<key>.json` path, and the second
// silently overwrote the first. If the first had been published, the second
// inherited its URL and `github-created` status, so plan 007's once-only guard
// suppressed a genuine second alert permanently — with the unauthenticated
// `/ingress/sentry` 202 reporting the outcome as published.
//
// Nothing bounds a pre-image. `createHash` takes a string of any length, so
// there was never a cost reason to cut; if a bound is wanted it belongs on the
// *digest*, which the `.slice(0, 16)` below already is. Truncating the input to
// a hash is what loses the event; truncating the hex never does.
export function fingerprintFor(raw: Record<string, unknown>): string {
  const id = str(raw.event_id) || str(raw.eventId) || str(raw.id);
  if (id) return id;
  const msg = str(raw.message) || str(raw.title) || JSON.stringify(raw);
  const culprit = str(raw.culprit) || str(raw.transaction) || "";
  return createHash("sha256").update(`${msg}|${culprit}`).digest("hex").slice(0, 16);
}

// The Source-line note distinguishes a stored mock draft from a body meant
// for a real `gh issue create`.
const SOURCE_NOTE_MOCK = "mock — GitHub API not called";
const SOURCE_NOTE_GH = "created via gh issue create";

// A UTF-8 prefix of `value`, cut at a byte boundary so the cut never lands
// mid-character. Same trade plan 010's `capBody` makes: cutting the parsed
// object instead would have to guess which keys matter and could leave a
// structure that still reads as real data.
function bytePrefix(value: string, maxBytes: number): string {
  return Buffer.from(value, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/�$/, "");
}

function capHeader(value: string): string {
  return value.length > ISSUE_HEADER_MAX_CHARS ? `${value.slice(0, ISSUE_HEADER_MAX_CHARS)}…` : value;
}

function buildDraft(
  source: "sentry" | "bugsink",
  raw: Record<string, unknown>,
  sourceNote: string,
): IssueDraft {
  const message = str(raw.message) || str(raw.title) || "unknown error";
  // The header lines are drawn from the same caller-controlled payload as the
  // JSON block, so they need a bound of their own — otherwise a 20 MB
  // `culprit` would make the payload cap below unreachable. Real values are
  // tens of characters. `project` and `level` are capped once and reused for
  // the title and the labels, so nothing uncapped escapes into those either.
  const culprit = capHeader(str(raw.culprit) || str(raw.transaction) || str(raw.logger) || "");
  const project = capHeader(str(raw.project) || str(raw.project_name) || "unknown");
  const level = capHeader(str(raw.level) || "error");
  // Fingerprint the *full* payload, before anything below is cut: two large
  // events that share a prefix must not collapse onto one fingerprint and lose
  // a real report. (Plan 033: the ordering was always right, but
  // `fingerprintFor` then cut its own input to 200 characters, so this was
  // true only of the call and not of the function. It hashes the whole
  // serialized payload now.)
  const fingerprint = fingerprintFor(raw);
  // ...but it is capped where it enters the *body*, at the same bound as the
  // lines above. `fingerprintFor` returns a caller-supplied `event_id` /
  // `eventId` / `id` verbatim, and 200 KB of one puts the body past the OS
  // single-argv limit on its own, with the whole event still inside the payload
  // cap and so never looking oversized to an operator.
  //
  // Capped here rather than inside `fingerprintFor` on purpose: `draft.fingerprint`
  // is the draft's identity — it keys `storageKeyFor`, and plan 007's replay
  // guard matches on it — so the whole id still reaches storage and two long
  // ids sharing a 500-char prefix cannot collapse onto one draft. Only the copy
  // that `gh issue create` would carry as an argument is bounded.
  const fingerprintLine = capHeader(fingerprint);
  const createdAt = new Date().toISOString();
  const title = `[${source}] ${project}: ${message}`.slice(0, 120);

  // The cap is measured against the string that actually reaches the body, not
  // against a different serialization of the same object. Below the cap the
  // block is pretty-printed, which for a payload of many small keys runs two to
  // three times the compact form — so a ~52 KB event passed the cap as compact
  // JSON and then overflowed the argv limit once indented, with no truncation
  // flag to say so. Serialize once, cut that string, and derive the flag from
  // the cut rather than from the guess that picked the form.
  const serialized = JSON.stringify(raw);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  // Below the cap nothing changes at all — same pretty-printed block, same
  // stored object. Above it the block holds a prefix of the serialized event,
  // embedded verbatim rather than re-stringified: re-encoding the prefix would
  // escape it and could inflate it back past the cap.
  const embedded = serializedBytes > ISSUE_PAYLOAD_MAX_BYTES ? serialized : JSON.stringify(raw, null, 2);
  const payload = bytePrefix(embedded, ISSUE_PAYLOAD_MAX_BYTES);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const truncated = payload.length !== embedded.length;

  const body = [
    `Playbook: ${PLAYBOOK_SENTRY}`,
    `Source: ${source} (${sourceNote})`,
    `Project: ${project}`,
    `Level: ${level}`,
    culprit ? `Culprit: ${culprit}` : null,
    `Fingerprint: ${fingerprintLine}`,
    "",
    "```json",
    payload,
    "```",
  ]
    .filter(Boolean)
    .join("\n");
  const labels = ["mock", source, level, PLAYBOOK_SENTRY];
  return {
    id: fingerprint,
    title,
    body,
    labels,
    source,
    playbook: PLAYBOOK_SENTRY,
    fingerprint,
    createdAt,
    status: "mock-draft",
    raw: truncated ? payload : raw,
    ...(truncated ? { bodyTruncated: true, bodyBytes: payloadBytes } : {}),
  };
}

export function normalizeErrorEvent(source: "sentry" | "bugsink", raw: Record<string, unknown>): IssueDraft {
  return buildDraft(source, raw, SOURCE_NOTE_MOCK);
}

// Filesystem-safe storage key: ordinary IDs keep the legacy filename; anything
// else (separators, "..", whitespace, unicode, overlong) is encoded. The `~`
// prefix namespace is excluded from the direct-ID allowlist so a direct ID can
// never alias an encoded name.
const SAFE_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

function storageKeyFor(fingerprint: string): string {
  if (SAFE_KEY_RE.test(fingerprint)) return fingerprint;
  return `~${createHash("sha256").update(fingerprint).digest("hex")}`;
}

function draftPathFor(draft: IssueDraft): string {
  const path = join(ISSUES_DIR, `${draft.source}-${storageKeyFor(draft.fingerprint)}.json`);
  // Containment check: identifiers are data, never path components that could
  // escape the issues directory.
  if (dirname(resolve(path)) !== resolve(ISSUES_DIR)) {
    throw new Error(`issue draft path escapes issues dir: ${draft.fingerprint}`);
  }
  return path;
}

function readStoredDraft(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// An upstream replay of the same event re-normalizes to a fresh mock draft, but
// the draft file is the record of what was actually filed. Once it is
// published, the published fields and the original createdAt are carried over
// from the stored copy and only volatile fields (title/body/labels/raw) are
// refreshed from the inbound payload.
function mergePublishedState(draft: IssueDraft, stored: IssueDraft): IssueDraft {
  return {
    ...draft,
    status: "github-created",
    githubIssueUrl: stored.githubIssueUrl,
    ...(stored.githubIssueNumber != null ? { githubIssueNumber: stored.githubIssueNumber } : {}),
    createdAt: stored.createdAt,
  };
}

// Eviction is not free here: a draft is the record of what was filed, and a
// `github-created` one is specifically what stops an upstream replay filing a
// duplicate issue. Those are never evicted — only `mock-draft` entries go, and
// oldest-first. `keepPath` is the draft just written, mirroring `trimQueue`'s
// "newest always survives": a single draft that is itself over the byte budget
// must leave the directory holding that draft rather than emptying it.
//
// Ordering is by mtime, which for this purpose tracks `createdAt`: a
// `mock-draft` is never rewritten (the rewrite path in `mergePublishedState`
// only fires for an already-published one), so its file mtime is its write
// time. Using it means the sweep reads a draft only when it is about to evict
// it — reading every file on every ingest would make this bound quadratic in
// exactly the directory it exists to bound.
//
// Filesystem timestamp granularity is coarse (a burst of writes can share one
// mtime down to the nanosecond, so ns precision buys nothing), so drafts the
// filesystem cannot tell apart are ordered by name. That is a determinism
// tie-break, not an age claim: among drafts of indistinguishable age any order
// is correct, and a fixed one keeps "what did the bound evict" reproducible
// instead of varying with directory read order.
function trimIssueDrafts(keepPath: string): string[] {
  if (!existsSync(ISSUES_DIR)) return [];
  const entries = [];
  for (const name of readdirSync(ISSUES_DIR)) {
    if (!name.endsWith(".json")) continue;
    const path = join(ISSUES_DIR, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    entries.push({ path, name, size: stats.size, mtimeMs: stats.mtimeMs });
  }
  let count = entries.length;
  let bytes = entries.reduce((total, e) => total + e.size, 0);
  const evicted: string[] = [];
  const oldestFirst = [...entries].sort(
    (a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const entry of oldestFirst) {
    if (count <= ISSUES_DIR_MAX_DRAFTS && bytes <= ISSUES_DIR_MAX_BYTES) break;
    if (entry.path === keepPath) continue;
    if (readStoredDraft(entry.path)?.status !== "mock-draft") continue;
    try {
      unlinkSync(entry.path);
    } catch {
      continue;
    }
    count -= 1;
    bytes -= entry.size;
    evicted.push(entry.name);
  }
  return evicted;
}

export function writeIssueDraft(draft: IssueDraft): IssueDraft {
  if (draft.source !== "sentry" && draft.source !== "bugsink") {
    throw new Error(`invalid issue source: ${String(draft.source)}`);
  }
  if (typeof draft.fingerprint !== "string" || !draft.fingerprint) {
    throw new Error("issue draft fingerprint must be a non-empty string");
  }
  // Plan 026: a `github-created` draft with no URL is unreadable as "published"
  // by either once-only guard — they both key on the URL — so it reads as
  // "never published" and a replay files a duplicate issue. Refusing it here
  // makes the invariant hold at the one place that persists, rather than
  // depending on every caller having parsed a URL out of `gh`'s output.
  if (draft.status === "github-created" && typeof draft.githubIssueUrl !== "string") {
    throw new Error("issue draft status github-created requires a githubIssueUrl");
  }
  const path = draftPathFor(draft);
  mkdirSync(ISSUES_DIR, { recursive: true });
  const previous = readStoredDraft(path);
  const effective =
    previous && previous.status === "github-created" && typeof previous.githubIssueUrl === "string"
      ? mergePublishedState(draft, previous as unknown as IssueDraft)
      : draft;
  const stored = { ...effective, path };
  // Atomic because `readStoredDraft` is what plan 007's published-once guard
  // stands on: a torn draft parses as no draft, and "no draft" reads as
  // "never published", which is how one incident becomes two GitHub issues.
  writeJsonAtomic(path, stored);
  // Trimmed after the write, so the new draft is counted and is the one kept.
  // The eviction list rides on the returned copy only — the file on disk never
  // carries it, so `listIssueDrafts` cannot read one draft's eviction as
  // another draft's record.
  const evicted = trimIssueDrafts(path);
  return evicted.length ? { ...stored, evicted } : stored;
}

export function ingestErrorEvent(source: "sentry" | "bugsink", raw: Record<string, unknown>): IssueDraft {
  return writeIssueDraft(normalizeErrorEvent(source, raw));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Fields for a real `gh issue create`: the draft's own title, a body that no
// longer claims GitHub was never called, and labels minus "mock" (source,
// level and playbook are kept).
export function githubIssueSpec(draft: IssueDraft): { title: string; body: string; labels: string[] } {
  const body = isRecord(draft.raw)
    ? buildDraft(draft.source, draft.raw, SOURCE_NOTE_GH).body
    : draft.body.split(SOURCE_NOTE_MOCK).join(SOURCE_NOTE_GH);
  return { title: draft.title, body, labels: draft.labels.filter((l) => l !== "mock") };
}

// argv for `gh issue create` — an array, never a shell string. `gh` resolves
// the target repo from the git remote of cwd (process.cwd()).
export function ghIssueCreateArgv(draft: IssueDraft): string[] {
  const spec = githubIssueSpec(draft);
  return [
    "issue",
    "create",
    "--title",
    spec.title,
    "--body",
    spec.body,
    ...spec.labels.flatMap((label) => ["--label", label]),
  ];
}

// Publishing is a network write, so it gets a larger budget than a chat
// adapter. The env name stays distinct from HARNESS_CHAT_TIMEOUT_MS so the two
// subprocess budgets can be tuned separately.
export const GH_TIMEOUT_ENV = "HARNESS_GH_TIMEOUT_MS";
export const DEFAULT_GH_TIMEOUT_MS = 60_000;
export const MIN_GH_TIMEOUT_MS = 1_000;
export const MAX_GH_TIMEOUT_MS = 5 * 60_000;

// --- draft bounds ------------------------------------------------------------
// `/ingress/sentry` and `/ingress/bugsink` are unauthenticated and bypass the
// gateway's ingress caps entirely, so the draft is the only bound on what one
// POST can write. Two things were unbounded: the payload — embedded in `body`
// and stored again in `raw`, the same bytes twice, so a 2 MB event became a
// 4.2 MB file — and how many drafts the directory could hold.
//
// The payload cap has to clear two ceilings at once. It must sit well above a
// real alert: a Sentry or Bugsink event is a few KB, and a busy stack trace
// with a long breadcrumb list runs to tens of KB. And it must sit *below* the
// OS limit on a single argument, because `gh issue create` takes the whole body
// as one argv element and Linux caps that at MAX_ARG_STRLEN (32 pages = 128
// KiB); measured here, posix_spawn returns E2BIG at about 131 KB. 96 KiB plus
// the header — four capped lines and the fence, ~2 KB — leaves roughly 30 KB of
// margin, so a draft inside the cap is always publishable. Anything larger is
// cut rather than dropped, and the cut is visible on the draft.
const ISSUE_PAYLOAD_MAX_BYTES = 96 * 1024;
// Real `Project`/`Level`/`Culprit` values are tens of characters; the title is
// already sliced to 120. Without this a caller could make the header alone
// megabytes and the payload cap would never be reached.
const ISSUE_HEADER_MAX_CHARS = 500;

// `listIssueDrafts` reads the whole directory on every `issues list`, `pick` and
// `summary`, so growth here is paid on every operator command rather than only
// at ingest. Same shape as the gateway's ingress queue: a count window and a
// byte budget on top. At the payload cap the byte budget binds first (~170
// drafts); with ordinary multi-KB alerts the count window binds at 200.
const ISSUES_DIR_MAX_DRAFTS = 200;
const ISSUES_DIR_MAX_BYTES = 16 * 1024 * 1024;

export function ghTimeoutMs(): number {
  const n = Number(process.env[GH_TIMEOUT_ENV]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GH_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), MIN_GH_TIMEOUT_MS), MAX_GH_TIMEOUT_MS);
}

// A bounded spawnSync that hits its timer reports ETIMEDOUT alongside the
// killSignal we asked for; a wedged child that only surfaced as SIGKILL counts
// too, since SIGKILL cannot be caught and escaped.
function ghTimedOut(r: SpawnSyncReturns<string>): boolean {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ETIMEDOUT" || r.signal === "SIGKILL";
}

export type GhCreateOutcome = {
  ok: boolean;
  command: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  url?: string;
  issueNumber?: number;
  skipped?: "already-published";
  draft: IssueDraft;
};

// Publish a stored draft via `gh issue create`. On success the draft file is
// rewritten with status "github-created" plus the issue URL/number; on any
// failure the on-disk draft is left untouched. Success requires a URL parsed
// out of `gh`'s stdout — an exit 0 we cannot identify is reported as a failure
// and persisted as nothing, because the URL is what both once-only guards read
// as proof of publication.
export function publishIssueDraft(draft: IssueDraft, ghBin = "gh"): GhCreateOutcome {
  // A draft already published for this fingerprint must never file a second
  // issue: replay the recorded outcome without spawning `gh`.
  if (draft.status === "github-created" && draft.githubIssueUrl) {
    return {
      ok: true,
      command: [],
      status: null,
      stdout: "",
      stderr: "",
      url: draft.githubIssueUrl,
      ...(draft.githubIssueNumber != null ? { issueNumber: draft.githubIssueNumber } : {}),
      skipped: "already-published",
      draft,
    };
  }
  const args = ghIssueCreateArgv(draft);
  const command = [ghBin, ...args];
  const bodyBytes = Buffer.byteLength(args[args.indexOf("--body") + 1] ?? "", "utf8");
  const timeoutMs = ghTimeoutMs();
  const r = spawnSync(ghBin, args, {
    encoding: "utf8",
    // `gh` resolves the target repo from the git remote of cwd; unchanged.
    cwd: process.cwd(),
    timeout: timeoutMs,
    // stdin is ignored so `gh` can never block on a terminal question there is
    // nobody to answer, and SIGKILL so a wedged child actually dies.
    stdio: ["ignore", "pipe", "pipe"],
    killSignal: "SIGKILL",
  });
  // Two different concerns, so two copies: the 500-char slice bounds what is
  // *reported* in the outcome, while matching runs against the untruncated
  // stdout, because a wrapper or a newer `gh` can print well past 500
  // characters before the URL.
  const fullStdout = (r.stdout || "").trim();
  const stdout = fullStdout.slice(0, 500);
  const stderr = (r.stderr || "").trim().slice(0, 500);
  if (ghTimedOut(r)) {
    // A timeout means we do not know whether GitHub filed the issue, so the
    // failure path stays conservative: the draft on disk keeps its
    // mock-draft status and re-running is safe.
    return {
      ok: false,
      command,
      status: r.status,
      stdout,
      stderr,
      error:
        `gh issue create timed out after ${timeoutMs}ms; it may or may not have been filed, so re-running is safe`,
      draft,
    };
  }
  // An argument-list failure is not an unusable `gh`: the binary is present and
  // working, and the real cause is the size of the body the draft handed it.
  // Reporting it as "gh not usable" sends the operator to debug their CLI for a
  // problem their CLI does not have.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "E2BIG") {
    return {
      ok: false,
      command,
      status: r.status,
      stdout,
      stderr,
      error:
        `gh issue create argument list too long (E2BIG): the issue body is ${bodyBytes} bytes, ` +
        `past the OS limit on a single argument (~128 KiB on Linux). Draft payloads are capped at ` +
        `${ISSUE_PAYLOAD_MAX_BYTES} bytes and header values at ${ISSUE_HEADER_MAX_CHARS} chars, so a ` +
        `draft written through these paths cannot reach this — it was stored before those bounds. ` +
        `Re-ingest the event to rebuild it inside them.`,
      draft,
    };
  }
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      command,
      status: r.status,
      stdout,
      stderr,
      error: r.error
        ? `gh not usable (${ghBin}): ${r.error.message}`
        : `gh issue create exited ${r.status ?? r.signal ?? "unknown"}`,
      draft,
    };
  }
  // The host is not hardcoded to `github.com`: `gh` prints a GHES URL for GitHub
  // Enterprise Server (`GH_HOST`, `gh auth login --hostname`), and that is just
  // as good proof of publication. Anchored on `/issues/<n>`, so an ordinary
  // `github.com` URL still matches exactly what it always did.
  const match = fullStdout.match(/https:\/\/[^\s/]+\/[^\s]*\/issues\/(\d+)/);
  if (!match) {
    // `gh` exited 0, so the issue was filed — but we cannot identify it. Do NOT
    // persist `github-created` here: both once-only guards key on the URL, so
    // that state would read as "never published", the next ingest would spawn
    // `gh` again, and a plain re-ingest would erase the record of the publish.
    // Same conservative shape as the timeout branch above, with the opposite
    // advice: the issue may exist, so say so instead of reporting success.
    return {
      ok: false,
      command,
      status: r.status,
      stdout,
      stderr,
      error:
        `gh issue create exited 0 but printed no recognisable issue URL, so the issue may have ` +
        `been filed and cannot be linked to this draft; re-running risks a duplicate — check the ` +
        `repository's issues before retrying`,
      draft,
    };
  }
  const url = match[0];
  const issueNumber = Number(match[1]);
  const stored = writeIssueDraft({
    ...draft,
    status: "github-created",
    githubIssueUrl: url,
    ...(issueNumber != null ? { githubIssueNumber: issueNumber } : {}),
  });
  return { ok: true, command, status: r.status, stdout, stderr, url, issueNumber, draft: stored };
}

export function listIssueDrafts(): IssueDraft[] {
  if (!existsSync(ISSUES_DIR)) return [];
  const files = readdirSync(ISSUES_DIR).filter((f) => f.endsWith(".json"));
  const out: IssueDraft[] = [];
  for (const f of files) {
    // Through `readStoredDraft`, so the two readers of this directory cannot
    // disagree about what a file may contain. A `.json` holding `null`, `[]`
    // or `"x"` parses, and pushing it here would hand `cmdPick` and
    // `cmdSummary` a value whose `.status` and `.fingerprint` they then read.
    const parsed = readStoredDraft(join(ISSUES_DIR, f));
    if (parsed) out.push(parsed as IssueDraft);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

// Pick priority: drafts carry the event level both as a label and in raw.level.
// Higher severity wins; unknown/missing levels rank lowest ("other").
const SEVERITY_RANK: Record<string, number> = {
  fatal: 4,
  error: 3,
  warning: 2,
  info: 1,
};

export function issueSeverity(draft: IssueDraft): string {
  const candidates: unknown[] = [
    ...(draft.labels ?? []),
    isRecord(draft.raw) ? draft.raw.level : null,
  ];
  let best = "other";
  for (const candidate of candidates) {
    const name = typeof candidate === "string" ? candidate.toLowerCase() : "";
    if ((SEVERITY_RANK[name] ?? 0) > (SEVERITY_RANK[best] ?? 0)) best = name;
  }
  return best;
}

// Ordered for picking: severity desc, then createdAt desc, then fingerprint
// for determinism. listIssueDrafts stays createdAt-only for `issues list`.
export function rankIssueDrafts(drafts: IssueDraft[]): IssueDraft[] {
  return [...drafts].sort((a, b) => {
    const diff = (SEVERITY_RANK[issueSeverity(b)] ?? 0) - (SEVERITY_RANK[issueSeverity(a)] ?? 0);
    if (diff !== 0) return diff;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  });
}
