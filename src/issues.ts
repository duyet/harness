import { createHash } from "node:crypto";
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
  status: "mock-draft";
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

export function normalizeErrorEvent(source: "sentry" | "bugsink", raw: Record<string, unknown>): IssueDraft {
  const message = str(raw.message) || str(raw.title) || "unknown error";
  const culprit = str(raw.culprit) || str(raw.transaction) || str(raw.logger) || "";
  const project = str(raw.project) || str(raw.project_name) || "unknown";
  const level = str(raw.level) || "error";
  const fingerprint = fingerprintFor(raw);
  const createdAt = new Date().toISOString();
  const title = `[${source}] ${project}: ${message}`.slice(0, 120);
  const body = [
    `Playbook: ${PLAYBOOK_SENTRY}`,
    `Source: ${source} (mock — GitHub API not called)`,
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
