import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = join(homedir(), ".local", "state", "herdr-harness");
export const STATE_FILE = join(STATE_DIR, "state.json");
export const GATEWAY_PID_FILE = join(STATE_DIR, "gateway.pid");
export const GATEWAY_META_FILE = join(STATE_DIR, "gateway.json");
export const INGRESS_QUEUE_FILE = join(STATE_DIR, "ingress-queue.json");
export const LAST_INGRESS_FILE = join(STATE_DIR, "last-ingress.json");
export const ISSUES_DIR = join(STATE_DIR, "issues");
export const SPAWNS_FILE = join(STATE_DIR, "spawns.json");
export const LAST_SUMMARY_FILE = join(STATE_DIR, "last-summary.md");
export const LAST_SUMMARY_JSON_FILE = join(STATE_DIR, "last-summary.json");
export const LAST_DELIVERY_FILE = join(STATE_DIR, "last-delivery.json");
export const PLAYBOOK_SENTRY = "desk:sentry-issues";

export const RESTART_RESUME_HINT =
  "Press Ctrl+G in the agent to restart and resume.";

// Ctrl+G is a user-level keybinding (plugins cannot declare keys). The plugin
// action id is <plugin>.<action> = harness.resume; the example snippet lives
// in the repo so `harness status --json` can point at it.
export const CTRL_G_ACTION = "harness.resume";
export const CTRL_G_EXAMPLE_CONFIG = join(
  ROOT,
  "examples",
  "herdr-config-ctrl-g.toml",
);

export type State = {
  started: boolean;
  startedAt?: string;
  sessionId?: string;
  agent?: string;
  installedVersion?: string;
  installedRoot?: string;
  gitDescribe?: string;
  // `eventAt` is the freeform tier's rotation cursor only: `id` there is
  // `event.taskId || "freeform"`, which for any untagged event records the
  // literal string "freeform" and so identifies nothing, while the queue is a
  // bounded ring whose positions renumber as old events are trimmed. The
  // event's own `at` is the only handle already on the entry that stays
  // meaningful. Optional, so a state.json written before rotation loads; absent
  // means "no cursor" and the tier falls back to the newest event.
  lastPicked?: { id: string; kind: string; adapter?: string; at: string; eventAt?: string };
};

export type AdapterRoute = {
  kind?: string;
  model?: string;
  via?: string;
  flags?: string[];
};

export type ChatAdapters = {
  // Extra route kinds `/chat execute` may spawn, on top of the built-in
  // non-interactive agent CLIs. Treat widening this list as a security review.
  executeKinds?: string[];
};

export type Adapters = {
  default?: string;
  routes?: Record<string, AdapterRoute>;
  chat?: ChatAdapters;
};

export type Task = {
  id: string;
  adapter?: string;
  worktree?: { branch?: string; base?: string; path?: string; label?: string };
};

export type Playbook = { id: string; description?: string };

export type HarnessConfig = {
  name?: string;
  agent?: string;
  soul?: string;
  adapters?: Adapters;
  tasks?: Task[];
  playbooks?: Playbook[];
};

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export const VERSION = packageVersion();

export function gitDescribe(): string | null {
  const r = spawnSync("git", ["describe", "--tags", "--always"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const s = (r.stdout || "").trim();
  return s || null;
}

// Plan 025 taught `gateway.ts`'s readers to check the shape they got rather
// than the shape they asked for, and promoted the check into `readJsonFile`.
// It left this file's three readers alone, and the helper cannot move here
// without `shared.ts` importing `gateway.ts` — the wrong way round, since
// `gateway.ts` already imports everything below. So the check is duplicated
// beside each parse instead: three lines, not a module.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadState(): State {
  if (!existsSync(STATE_FILE)) return { started: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // An array or a scalar parses just as cleanly as an object, and the next
    // writer would spread it into `{ "0": …, "1": …, lastPicked: {…} }` —
    // `started` and `sessionId` gone, so `start --resume` mints a fresh id.
    return isRecord(parsed) ? (parsed as State) : { started: false };
  } catch {
    return { started: false };
  }
}

// Every durable state file is rewritten in place, and every reader here
// silently falls back to an empty value when the bytes do not parse — so a
// write torn by a crash is not a small cosmetic problem. A half-written
// `spawns.json` reads as an empty map, and `manager spawn` answers that by
// creating a second worktree for a task that is already live; a half-written
// issue draft reads as no draft, which is exactly the "not published yet"
// state plan 007's once-only guard depends on.
//
// So: write a sibling temp file, then rename over the target. Readers see
// either the old bytes or the new ones, never a prefix. The temp file is a
// sibling by construction, so the rename stays inside one filesystem and does
// not degrade into a non-atomic copy.
export function writeFileAtomic(path: string, contents: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (e) {
    // A failed write must not leave an orphan beside the real file: the state
    // directory is small and long-lived, and a stale `.tmp` is indistinguishable
    // from a live writer's scratch file.
    try {
      unlinkSync(tmp);
    } catch {
      /* the write failed before the temp file existed; nothing to clean up */
    }
    throw e;
  }
}

export function writeJsonAtomic(path: string, value: unknown) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function saveState(state: State) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(STATE_FILE, state);
}

export type SpawnRecord = {
  taskId: string;
  adapterId?: string;
  agentName?: string;
  worktreePath?: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  cwd?: string;
  at: string;
};

export type SpawnsState = { spawns: Record<string, SpawnRecord> };

export function loadSpawns(): SpawnsState {
  if (!existsSync(SPAWNS_FILE)) return { spawns: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(SPAWNS_FILE, "utf8"));
    // The array-shaped file is the one that loses data quietly. `saveSpawn`
    // assigns a named key onto whatever this returns, and `JSON.stringify` of
    // an array drops named properties — so the record `manager spawn
    // --execute` just wrote (worktree, tab and agent already created) is gone
    // on the next read, and the "task already spawned" guard in `src/cli.ts`
    // reads the same empty map. The next spawn then builds a *second*
    // worktree and tab for a task that is already live: exactly the outcome
    // the atomic-write comment below this function exists to prevent.
    const spawns = isRecord(parsed) ? parsed.spawns : undefined;
    return { spawns: isRecord(spawns) ? (spawns as Record<string, SpawnRecord>) : {} };
  } catch {
    return { spawns: {} };
  }
}

export function saveSpawns(state: SpawnsState) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(SPAWNS_FILE, state);
}

export function saveSpawn(record: SpawnRecord) {
  const state = loadSpawns();
  state.spawns[record.taskId] = record;
  saveSpawns(state);
}

export function deleteSpawn(taskId: string) {
  const state = loadSpawns();
  if (!(taskId in state.spawns)) return;
  delete state.spawns[taskId];
  saveSpawns(state);
}

// Written by `harness summary --deliver`: the human-delivery stub record that
// `harness summary`, `harness gateway status` and /chat pickup can show.
export type LastDelivery = {
  kind: "summary";
  at: string;
  summaryPath: string;
  summaryJsonPath: string;
  deliveryPath: string;
  bytes: number;
  excerpt: string;
};

// `/chat` pickup interpolates `at` and `excerpt` straight into the reply and
// `/status` projects the rest, so the cast this replaces rendered whatever
// parsed. The two shapes that reach a human's chat window are an array — which
// inherits `Array.prototype.at`, hence a reply reading `last summary (function
// at() { [native code] })` — and a partial object, which renders `undefined`.
// `writeSummaryDelivery` in `src/cli.ts` is the only writer and writes all
// seven fields, so requiring them costs no real record; a file that is not a
// delivery reads as no delivery, which is the direction that fails quietly
// rather than loudly wrong.
function isLastDelivery(value: unknown): value is LastDelivery {
  return (
    isRecord(value) &&
    value.kind === "summary" &&
    typeof value.at === "string" &&
    typeof value.summaryPath === "string" &&
    typeof value.summaryJsonPath === "string" &&
    typeof value.deliveryPath === "string" &&
    typeof value.excerpt === "string" &&
    typeof value.bytes === "number" &&
    Number.isFinite(value.bytes)
  );
}

export function lastDelivery(): LastDelivery | null {
  if (!existsSync(LAST_DELIVERY_FILE)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(LAST_DELIVERY_FILE, "utf8"));
    return isLastDelivery(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function findConfigPath(): string | null {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, ".herdr-harness.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const example = join(ROOT, "examples", "minimal", ".herdr-harness.json");
  if (existsSync(example)) return example;
  return null;
}

export function loadConfig(): { path: string | null; config: HarnessConfig | null } {
  const path = findConfigPath();
  if (!path) return { path: null, config: null };
  try {
    return { path, config: JSON.parse(readFileSync(path, "utf8")) as HarnessConfig };
  } catch {
    return { path, config: null };
  }
}

export function resolveTask(taskId: string | undefined) {
  const { path: configPath, config } = loadConfig();
  const tasks = config?.tasks ?? [];
  const adapters = config?.adapters?.routes ?? {};
  const defaultAdapter = config?.adapters?.default ?? config?.agent ?? "grok-build";
  if (!taskId) {
    return { error: "missing taskId", configPath, defaultAdapter, tasks, adapters };
  }
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return { error: `unknown task: ${taskId}`, configPath, defaultAdapter, tasks, adapters };
  }
  const adapterId = task.adapter ?? defaultAdapter;
  const route = adapters[adapterId] ?? null;
  return {
    error: null as string | null,
    configPath,
    task,
    adapterId,
    route,
    defaultAdapter,
    adapters,
    tasks,
  };
}

export function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

export function gatewayBind() {
  const hostname = process.env.HARNESS_GATEWAY_HOST || "127.0.0.1";
  const port = Number(process.env.HARNESS_GATEWAY_PORT || "8787");
  return { hostname, port };
}
