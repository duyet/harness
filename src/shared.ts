import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

export type State = {
  started: boolean;
  startedAt?: string;
  sessionId?: string;
  agent?: string;
  installedVersion?: string;
  installedRoot?: string;
  gitDescribe?: string;
  lastPicked?: { id: string; kind: string; adapter?: string; at: string };
};

export type AdapterRoute = {
  kind?: string;
  model?: string;
  via?: string;
  flags?: string[];
};

export type Adapters = {
  default?: string;
  routes?: Record<string, AdapterRoute>;
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

export function loadState(): State {
  if (!existsSync(STATE_FILE)) return { started: false };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return { started: false };
  }
}

export function saveState(state: State) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
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
    const parsed = JSON.parse(readFileSync(SPAWNS_FILE, "utf8"));
    return { spawns: parsed?.spawns ?? {} };
  } catch {
    return { spawns: {} };
  }
}

export function saveSpawns(state: SpawnsState) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SPAWNS_FILE, `${JSON.stringify(state, null, 2)}\n`);
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

export function lastDelivery(): LastDelivery | null {
  if (!existsSync(LAST_DELIVERY_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(LAST_DELIVERY_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as LastDelivery) : null;
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
