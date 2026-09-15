#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_PATH = join(ROOT, "bin", "harness");
const LINK_PATH = join(homedir(), ".local", "bin", "harness");
const STATE_DIR = join(homedir(), ".local", "state", "herdr-harness");
const STATE_FILE = join(STATE_DIR, "state.json");

/** After an in-place upgrade, a running agent still has the old process in memory. */
const RESTART_RESUME_HINT =
  "Press Ctrl+G in the agent to restart and resume.";

type State = {
  started: boolean;
  startedAt?: string;
  sessionId?: string;
  agent?: string;
  installedVersion?: string;
  installedRoot?: string;
  gitDescribe?: string;
};

type AdapterRoute = {
  kind?: string;
  model?: string;
  via?: string;
  flags?: string[];
};

type Adapters = {
  default?: string;
  routes?: Record<string, AdapterRoute>;
};

type Task = {
  id: string;
  adapter?: string;
  worktree?: { branch?: string; base?: string; path?: string; label?: string };
};

type HarnessConfig = {
  name?: string;
  agent?: string;
  soul?: string;
  adapters?: Adapters;
  tasks?: Task[];
};

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const VERSION = packageVersion();

function gitDescribe(): string | null {
  const r = spawnSync("git", ["describe", "--tags", "--always"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const s = (r.stdout || "").trim();
  return s || null;
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return { started: false };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return { started: false };
  }
}

function saveState(state: State) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function findConfigPath(): string | null {
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

function loadConfig(): { path: string | null; config: HarnessConfig | null } {
  const path = findConfigPath();
  if (!path) return { path: null, config: null };
  try {
    return { path, config: JSON.parse(readFileSync(path, "utf8")) as HarnessConfig };
  } catch {
    return { path, config: null };
  }
}

function argvFlags(from = 3): Set<string> {
  return new Set(process.argv.slice(from).filter((a) => a.startsWith("-")));
}

function positional(from = 3): string[] {
  return process.argv.slice(from).filter((a) => !a.startsWith("-"));
}

function resolvedLinkTarget(): string | null {
  try {
    return realpathSync(LINK_PATH);
  } catch {
    return null;
  }
}

function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

function cmdStart() {
  const f = argvFlags();
  const wantResume = f.has("--resume");
  const prev = loadState();
  const { config } = loadConfig();
  const agent =
    config?.agent ??
    config?.adapters?.default ??
    prev.agent ??
    "grok-build";

  const now = new Date().toISOString();
  const sessionId =
    wantResume && prev.sessionId ? prev.sessionId : randomUUID();
  const startedAt =
    wantResume && prev.sessionId && prev.startedAt ? prev.startedAt : now;

  const state: State = {
    ...prev,
    started: true,
    startedAt,
    sessionId,
    agent,
    installedVersion: VERSION,
    installedRoot: ROOT,
    gitDescribe: gitDescribe() ?? prev.gitDescribe,
  };
  saveState(state);
  console.log("ok");
  console.log(`harness started at ${state.startedAt}`);
  console.log(`session: ${state.sessionId}`);
  if (wantResume) console.log("resumed existing session");
}

function cmdStatus() {
  const state = loadState();
  const { path: configPath, config } = loadConfig();
  const defaultAdapter = config?.adapters?.default ?? config?.agent ?? null;
  const json = {
    ok: true,
    plugin: "harness",
    version: VERSION,
    started: state.started,
    startedAt: state.startedAt ?? null,
    sessionId: state.sessionId ?? null,
    agent: state.agent ?? null,
    defaultAdapter,
    adapters: config?.adapters?.routes ?? {},
    tasks: config?.tasks ?? [],
    configPath,
    root: ROOT,
    stateFile: STATE_FILE,
  };
  if (process.argv.includes("--json") || !process.stdout.isTTY) {
    printJson(json);
    return;
  }
  console.log(`harness ${VERSION}`);
  console.log(`status:  ${state.started ? "started" : "idle"}`);
  if (state.startedAt) console.log(`since:   ${state.startedAt}`);
  if (state.sessionId) console.log(`session: ${state.sessionId}`);
  if (defaultAdapter) console.log(`adapter: ${defaultAdapter}`);
  console.log(`root:    ${ROOT}`);
  console.log("ok");
}

function relink(): boolean {
  mkdirSync(dirname(LINK_PATH), { recursive: true });
  const want = resolve(BIN_PATH);
  const current = resolvedLinkTarget();
  if (current === want && existsSync(LINK_PATH)) return false;
  try {
    unlinkSync(LINK_PATH);
  } catch {
    // missing is fine
  }
  symlinkSync(want, LINK_PATH);
  return true;
}

function cmdUpgrade() {
  const checkoutVersion = VERSION;
  const describe = gitDescribe();
  const state = loadState();
  const linkTarget = resolvedLinkTarget();
  const wantBin = resolve(BIN_PATH);
  const linkBroken = !linkTarget || !existsSync(linkTarget);
  const targetWrong = linkTarget !== wantBin;
  const versionDrift =
    !state.installedVersion || state.installedVersion !== checkoutVersion;
  const rootDrift = state.installedRoot && state.installedRoot !== ROOT;
  const gitDrift =
    describe && state.gitDescribe && state.gitDescribe !== describe;

  const needs =
    linkBroken || targetWrong || versionDrift || rootDrift || gitDrift || !existsSync(LINK_PATH);

  console.log(`harness upgrade (local, no network)`);
  console.log(`checkout version: ${checkoutVersion}`);
  if (describe) console.log(`git describe:     ${describe}`);
  console.log(`installed:        ${state.installedVersion ?? "(none)"} @ ${state.installedRoot ?? "(none)"}`);
  console.log(`link:             ${LINK_PATH} -> ${linkTarget ?? "(missing)"}`);

  if (!needs) {
    console.log("already up to date");
    console.log(RESTART_RESUME_HINT);
    return;
  }

  const didLink = relink();
  const next: State = {
    ...state,
    installedVersion: checkoutVersion,
    installedRoot: ROOT,
    gitDescribe: describe ?? state.gitDescribe,
  };
  saveState(next);
  if (didLink || targetWrong || linkBroken) {
    console.log(`relinked ${LINK_PATH} -> ${wantBin}`);
  }
  console.log(`recorded version ${checkoutVersion}`);
  console.log(RESTART_RESUME_HINT);
}

function cmdResume() {
  const state = loadState();
  if (!state.sessionId) {
    console.error("nothing to resume: no session id in state");
    console.error(`state file: ${STATE_FILE}`);
    console.error("run: harness start");
    process.exit(1);
  }
  console.log("restored session");
  console.log(`sessionId: ${state.sessionId}`);
  console.log(`startedAt: ${state.startedAt ?? "(unknown)"}`);
  console.log(`agent:     ${state.agent ?? "(unknown)"}`);
  console.log(RESTART_RESUME_HINT);
  console.log("(Ctrl+G = restart + resume; this CLI path is harness resume)");
}

function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function herdrUsable(): { ok: boolean; reason: string; bin: string } {
  const bin = herdrBin();
  const sock =
    process.env.HERDR_SOCKET ||
    join(homedir(), ".config", "herdr", "herdr.sock");
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return {
      ok: false,
      reason: `herdr binary not usable (${bin}): ${probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`}`,
      bin,
    };
  }
  if (!existsSync(sock)) {
    return { ok: false, reason: `no herdr socket at ${sock}`, bin };
  }
  return { ok: true, reason: "herdr binary + socket present", bin };
}

function resolveTask(taskId: string | undefined) {
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
    error: null,
    configPath,
    task,
    adapterId,
    route,
    defaultAdapter,
  };
}

function cmdManager() {
  const sub = process.argv[3];
  if (sub === "status") return cmdManagerStatus();
  if (sub === "route") return cmdManagerRoute();
  if (sub === "spawn") return cmdManagerSpawn();
  printJson({
    ok: false,
    error: sub ? `unknown manager subcommand: ${sub}` : "missing manager subcommand",
    usage: ["harness manager status", "harness manager route <taskId>", "harness manager spawn <taskId> [--execute]"],
  });
  process.exit(1);
}

function cmdManagerStatus() {
  const { path: configPath, config } = loadConfig();
  printJson({
    ok: true,
    version: VERSION,
    configPath,
    name: config?.name ?? null,
    soul: config?.soul ?? null,
    defaultAdapter: config?.adapters?.default ?? config?.agent ?? null,
    adapters: config?.adapters?.routes ?? {},
    tasks: config?.tasks ?? [],
  });
}

function cmdManagerRoute() {
  const taskId = positional(4)[0];
  const resolved = resolveTask(taskId);
  if (resolved.error) {
    printJson({ ok: false, ...resolved });
    process.exit(1);
  }
  printJson({ ok: true, ...resolved });
}

function intendedForTask(resolved: ReturnType<typeof resolveTask>) {
  if (resolved.error || !resolved.task) return [];
  const wt = resolved.task.worktree ?? {};
  const cmds: string[][] = [
    [
      "herdr",
      "worktree",
      "create",
      "--cwd",
      process.cwd(),
      ...(wt.branch ? ["--branch", wt.branch] : []),
      ...(wt.base ? ["--base", wt.base] : []),
      ...(wt.path ? ["--path", wt.path] : []),
      ...(wt.label ? ["--label", wt.label] : ["--label", `harness:${resolved.task.id}`]),
      "--no-focus",
    ],
  ];
  return cmds;
}

function cmdManagerSpawn() {
  const f = argvFlags(4);
  const execute = f.has("--execute");
  const taskId = positional(4)[0];
  const resolved = resolveTask(taskId);
  const intendedCommands = intendedForTask(resolved);
  const herdr = herdrUsable();

  if (resolved.error) {
    printJson({
      ok: false,
      mode: "dry-run",
      ...resolved,
      intendedCommands,
      herdr,
      todo: ["fix task id / config before spawn"],
    });
    process.exit(1);
  }

  if (!execute || !herdr.ok) {
    const why = !execute
      ? "default is dry-run; pass --execute to attempt herdr worktree create"
      : herdr.reason;
    printJson({
      ok: true,
      mode: "dry-run",
      ...resolved,
      intendedCommands,
      herdr,
      skippedExecute: why,
      todo: [
        "Pass --execute when a live Herdr socket is available",
        "Child agent spawn / tab create is not wired yet",
      ],
    });
    return;
  }

  const results = [];
  for (const cmd of intendedCommands) {
    const [bin, ...args] = cmd[0] === "herdr" ? [herdr.bin, ...cmd.slice(1)] : cmd;
    const r = spawnSync(bin, args, { encoding: "utf8" });
    results.push({
      command: [bin, ...args],
      status: r.status,
      stdout: (r.stdout || "").trim(),
      stderr: (r.stderr || "").trim(),
    });
  }
  printJson({
    ok: results.every((r) => r.status === 0),
    mode: "executed",
    ...resolved,
    intendedCommands,
    results,
    todo: ["tab/agent create after worktree is still a stub"],
  });
}

function usage() {
  console.log(`harness ${VERSION} — Herdr plugin CLI

Usage:
  harness start [--resume]              Start (new session id) or keep last session
  harness status                        Print status (add --json for JSON)
  harness upgrade                       Relink ~/.local/bin/harness to this checkout
  harness resume                        Restore last session from state
  harness manager status                List adapters, routes, tasks
  harness manager route <taskId>        Resolve task → adapter
  harness manager spawn <taskId>        Dry-run worktree spawn (--execute to try herdr)

Ctrl+G = restart + resume (user herdr config binds plugin_action harness.resume).
CLI path: harness resume. Plugins cannot declare keybindings.
`);
}

const cmd = process.argv[2] ?? "help";
switch (cmd) {
  case "start":
    cmdStart();
    break;
  case "status":
    cmdStatus();
    break;
  case "upgrade":
    cmdUpgrade();
    break;
  case "resume":
    cmdResume();
    break;
  case "manager":
    cmdManager();
    break;
  case "-h":
  case "--help":
  case "help":
    usage();
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    usage();
    process.exit(1);
}
