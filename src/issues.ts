import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ISSUES_DIR, PLAYBOOK_SENTRY } from "./shared.ts";

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
};

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function fingerprintFor(raw: Record<string, unknown>): string {
  const id = str(raw.event_id) || str(raw.eventId) || str(raw.id);
  if (id) return id;
  const msg = str(raw.message) || str(raw.title) || JSON.stringify(raw).slice(0, 200);
  const culprit = str(raw.culprit) || str(raw.transaction) || "";
  return createHash("sha256").update(`${msg}|${culprit}`).digest("hex").slice(0, 16);
}

// The Source-line note distinguishes a stored mock draft from a body meant
// for a real `gh issue create`.
const SOURCE_NOTE_MOCK = "mock — GitHub API not called";
const SOURCE_NOTE_GH = "created via gh issue create";

function buildDraft(
  source: "sentry" | "bugsink",
  raw: Record<string, unknown>,
  sourceNote: string,
): IssueDraft {
  const message = str(raw.message) || str(raw.title) || "unknown error";
  const culprit = str(raw.culprit) || str(raw.transaction) || str(raw.logger) || "";
  const project = str(raw.project) || str(raw.project_name) || "unknown";
  const level = str(raw.level) || "error";
  const fingerprint = fingerprintFor(raw);
  const createdAt = new Date().toISOString();
  const title = `[${source}] ${project}: ${message}`.slice(0, 120);
  const body = [
    `Playbook: ${PLAYBOOK_SENTRY}`,
    `Source: ${source} (${sourceNote})`,
    `Project: ${project}`,
    `Level: ${level}`,
    culprit ? `Culprit: ${culprit}` : null,
    `Fingerprint: ${fingerprint}`,
    "",
    "```json",
    JSON.stringify(raw, null, 2),
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
    raw,
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

export function writeIssueDraft(draft: IssueDraft): IssueDraft {
  if (draft.source !== "sentry" && draft.source !== "bugsink") {
    throw new Error(`invalid issue source: ${String(draft.source)}`);
  }
  if (typeof draft.fingerprint !== "string" || !draft.fingerprint) {
    throw new Error("issue draft fingerprint must be a non-empty string");
  }
  const path = draftPathFor(draft);
  mkdirSync(ISSUES_DIR, { recursive: true });
  const stored = { ...draft, path };
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
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

export type GhCreateOutcome = {
  ok: boolean;
  command: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  url?: string;
  issueNumber?: number;
  draft: IssueDraft;
};

// Publish a stored draft via `gh issue create`. On success the draft file is
// rewritten with status "github-created" plus the issue URL/number; on any
// failure the on-disk draft is left untouched.
export function publishIssueDraft(draft: IssueDraft, ghBin = "gh"): GhCreateOutcome {
  const args = ghIssueCreateArgv(draft);
  const command = [ghBin, ...args];
  const r = spawnSync(ghBin, args, { encoding: "utf8", cwd: process.cwd() });
  const stdout = (r.stdout || "").trim().slice(0, 500);
  const stderr = (r.stderr || "").trim().slice(0, 500);
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
  const url = stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/)?.[0];
  const issueNumber = url ? Number(url.split("/").pop()) : undefined;
  const stored = writeIssueDraft({
    ...draft,
    status: "github-created",
    ...(url ? { githubIssueUrl: url } : {}),
    ...(issueNumber != null ? { githubIssueNumber: issueNumber } : {}),
  });
  return { ok: true, command, status: r.status, stdout, stderr, url, issueNumber, draft: stored };
}

export function listIssueDrafts(): IssueDraft[] {
  if (!existsSync(ISSUES_DIR)) return [];
  const files = readdirSync(ISSUES_DIR).filter((f) => f.endsWith(".json"));
  const out: IssueDraft[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(ISSUES_DIR, f), "utf8")) as IssueDraft);
    } catch {
      /* skip */
    }
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
