#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ROOT,
  STATE_DIR,
  STATE_FILE,
  GATEWAY_PID_FILE,
  GATEWAY_META_FILE,
  INGRESS_QUEUE_FILE,
  VERSION,
  RESTART_RESUME_HINT,
  PLAYBOOK_SENTRY,
  loadState,
  saveState,
  loadConfig,
  gitDescribe,
  resolveTask,
  printJson,
  gatewayBind,
  loadSpawns,
  saveSpawn,
  deleteSpawn,
  type State,
  type SpawnRecord,
} from "./shared.ts";
import { lastIngress } from "./gateway.ts";
import { ingestErrorEvent, listIssueDrafts } from "./issues.ts";

const BIN_PATH = join(ROOT, "bin", "harness");
const LINK_PATH = join(homedir(), ".local", "bin", "harness");

function argvFlags(from = 3): Set<string> {
  return new Set(process.argv.slice(from).filter((a) => a.startsWith("-")));
}

function positional(from = 3): string[] {
  return process.argv.slice(from).filter((a) => !a.startsWith("-"));
}

function optValue(name: string, from = 3): string | undefined {
  const args = process.argv.slice(from);
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return undefined;
}

function resolvedLinkTarget(): string | null {
  try {
    return realpathSync(LINK_PATH);
  } catch {
    return null;
  }
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

function cmdManager() {
  const sub = process.argv[3];
  if (sub === "status") return cmdManagerStatus();
  if (sub === "route") return cmdManagerRoute();
  if (sub === "spawn") return cmdManagerSpawn();
  if (sub === "cleanup") return cmdManagerCleanup();
  printJson({
    ok: false,
    error: sub ? `unknown manager subcommand: ${sub}` : "missing manager subcommand",
    usage: [
      "harness manager status",
      "harness manager route <taskId>",
      "harness manager spawn <taskId> [--execute] [--replace] [--cleanup]",
      "harness manager cleanup <taskId> [--execute] [--force]",
    ],
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

// `herdr agent start --kind` values supported by the installed Herdr CLI.
const HERDR_AGENT_KINDS = new Set([
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
  "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
  "hermes", "kilo", "qodercli", "qwen", "maki",
]);

function taskLabel(taskId: string) {
  return `harness:${taskId}`;
}

type ResolvedTask = ReturnType<typeof resolveTask>;

// How the task's adapter is launched inside the new pane: a managed
// `herdr agent start --kind` when the route maps to a supported kind, else a
// shell command through `herdr pane run` (e.g. `anyr claude` via its kind+via).
function agentSpec(resolved: ResolvedTask) {
  const route = resolved.route ?? null;
  const kind = route?.kind ?? resolved.adapterId;
  const args = [
    ...(route?.model ? ["--model", route.model] : []),
    ...(route?.flags ?? []),
  ];
  const name = taskLabel(resolved.task!.id);
  if (kind && HERDR_AGENT_KINDS.has(kind)) {
    return { name, launch: "agent-start" as const, kind, args };
  }
  const command = [
    kind ?? resolved.adapterId ?? "agent",
    ...(route?.via ? [route.via] : []),
    ...args,
  ];
  return { name, launch: "shell" as const, kind: kind ?? null, command };
}

type SpawnCtx = { workspaceId?: string; worktreePath?: string; paneId?: string };

// Full planned spawn sequence. In dry-run, ids that only exist after a step
// runs are shown as <placeholders>; execute re-renders each step with the ids
// parsed from the previous step's JSON result.
function intendedSpawnCommands(resolved: ResolvedTask, ctx: SpawnCtx = {}) {
  if (resolved.error || !resolved.task) return [];
  const wt = resolved.task.worktree ?? {};
  const label = taskLabel(resolved.task.id);
  const ws = ctx.workspaceId ?? "<workspace-id>";
  const wtPath = ctx.worktreePath ?? wt.path ?? "<worktree-path>";
  const pane = ctx.paneId ?? "<pane-id>";
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
      "--label",
      wt.label ?? label,
      "--no-focus",
    ],
    [
      "herdr",
      "tab",
      "create",
      "--workspace",
      ws,
      "--cwd",
      wtPath,
      "--label",
      label,
      "--no-focus",
    ],
  ];
  const spec = agentSpec(resolved);
  cmds.push(
    spec.launch === "agent-start"
      ? [
          "herdr",
          "agent",
          "start",
          spec.name,
          "--kind",
          spec.kind!,
          "--pane",
          pane,
          ...(spec.args.length ? ["--", ...spec.args] : []),
        ]
      : ["herdr", "pane", "run", pane, ...spec.command],
  );
  return cmds;
}

// Cleanup plan: discover live tab/worktree state, then close the child tab
// (which stops its pane/agent) and remove the spawned worktree last.
function intendedCleanupCommands(
  record: SpawnRecord | undefined,
  force: boolean,
) {
  return [
    ["herdr", "tab", "list"],
    ["herdr", "worktree", "list", "--cwd", process.cwd()],
    ["herdr", "tab", "close", record?.tabId ?? "<tab-id>"],
    [
      "herdr",
      "worktree",
      "remove",
      "--workspace",
      record?.workspaceId ?? "<workspace-id>",
      ...(force ? ["--force"] : []),
    ],
  ];
}

type HerdrStep = {
  command: string[];
  status: number | null;
  stdout: string;
  stderr: string;
};

function runHerdr(herdrBin: string, args: string[]): HerdrStep {
  const r = spawnSync(herdrBin, args, { encoding: "utf8" });
  return {
    command: [herdrBin, ...args],
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

// Herdr CLI prints a single {"id":...,"result":{...}} JSON envelope on stdout.
function herdrResult(step: HerdrStep): Record<string, any> | null {
  for (const text of [step.stdout, step.stdout.split("\n").pop() ?? ""]) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed.result ?? parsed;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

// Ordered cleanup: list → close matching tab(s) → remove the worktree's
// workspace. Presence comes from live discovery; the persisted spawn record
// only supplies extra match hints and a fallback workspace id.
function executeCleanup(
  taskId: string,
  resolved: ResolvedTask | null,
  record: SpawnRecord | undefined,
  herdr: { bin: string },
  force: boolean,
) {
  const label = taskLabel(taskId);
  const wt = resolved?.task?.worktree ?? {};
  const wtLabel = wt.label ?? label;
  const results: HerdrStep[] = [];

  const tabsStep = runHerdr(herdr.bin, ["tab", "list"]);
  results.push(tabsStep);
  const wtStep = runHerdr(herdr.bin, ["worktree", "list", "--cwd", process.cwd()]);
  results.push(wtStep);
  if (tabsStep.status !== 0 || wtStep.status !== 0) {
    return { ok: false, error: "herdr discovery failed; not safe to clean up", results };
  }
  const tabs = herdrResult(tabsStep)?.tabs;
  const worktrees = herdrResult(wtStep)?.worktrees;
  if (!Array.isArray(tabs) || !Array.isArray(worktrees)) {
    return { ok: false, error: "could not parse herdr list output", results };
  }

  const tabIds = tabs
    .filter((t: any) => t?.tab_id === record?.tabId || t?.label === label)
    .map((t: any) => t.tab_id)
    .filter((id: any) => typeof id === "string");
  const wtMatch = worktrees.find(
    (w: any) =>
      w?.open_workspace_id === record?.workspaceId ||
      w?.path === record?.worktreePath ||
      (wt.path && w?.path === wt.path) ||
      w?.label === wtLabel,
  );
  const workspaceId = wtMatch?.open_workspace_id ?? record?.workspaceId ?? null;

  const closedTabs: string[] = [];
  for (const tabId of tabIds) {
    const r = runHerdr(herdr.bin, ["tab", "close", tabId]);
    results.push(r);
    if (r.status === 0) closedTabs.push(tabId);
  }
  let removedWorkspace: string | null = null;
  if (workspaceId) {
    const r = runHerdr(herdr.bin, [
      "worktree",
      "remove",
      "--workspace",
      workspaceId,
      ...(force ? ["--force"] : []),
    ]);
    results.push(r);
    if (r.status === 0) removedWorkspace = workspaceId;
  }

  const ok = results.every((r) => r.status === 0);
  if (ok) deleteSpawn(taskId);
  return {
    ok,
    results,
    found: { tabs: tabIds, worktrees: worktrees.length, workspaceId },
    closedTabs,
    removedWorkspace,
    cleaned: tabIds.length > 0 || removedWorkspace != null,
  };
}

function cmdManagerSpawn() {
  const f = argvFlags(4);
  const execute = f.has("--execute");
  const replace = f.has("--replace");
  const force = f.has("--force");
  const taskId = positional(4)[0];
  if (f.has("--cleanup")) return cmdManagerCleanup();
  const resolved = resolveTask(taskId);
  const intendedCommands = intendedSpawnCommands(resolved);
  const herdr = herdrUsable();
  const record = taskId ? loadSpawns().spawns[taskId] : undefined;

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
      ...(record ? { existingSpawn: record } : {}),
      ...(replace
        ? {
            replace: true,
            cleanup: {
              intendedCommands: intendedCleanupCommands(record, force),
            },
          }
        : {}),
      todo: [
        "Pass --execute when a live Herdr socket is available",
        ...(record
          ? [`existing spawn recorded for ${taskId}; pass --replace to respawn or --cleanup to remove`]
          : []),
      ],
    });
    return;
  }

  if (record && !replace) {
    printJson({
      ok: false,
      mode: "executed",
      ...resolved,
      error: `task already spawned: ${taskId}`,
      spawn: record,
      hint: "pass --replace to clean up and respawn, or --cleanup / `harness manager cleanup` to remove",
    });
    process.exit(1);
  }

  let cleanup: ReturnType<typeof executeCleanup> | null = null;
  if (replace) {
    cleanup = executeCleanup(taskId!, resolved, record, herdr, force);
    if (!cleanup.ok) {
      printJson({
        ok: false,
        mode: "executed",
        replace: true,
        ...resolved,
        error: "cleanup before re-spawn failed",
        cleanup,
        hint: "inspect cleanup.results; retry with --force or `harness manager cleanup`",
      });
      process.exit(1);
    }
  }

  const results: HerdrStep[] = [];
  const ctx: SpawnCtx = {};
  const spec = agentSpec(resolved);
  const spawn: SpawnRecord = {
    taskId: taskId!,
    adapterId: resolved.adapterId ?? undefined,
    cwd: process.cwd(),
    at: new Date().toISOString(),
  };
  const finish = (ok: boolean, extra: Record<string, unknown> = {}) => {
    printJson({
      ok,
      mode: "executed",
      ...(replace ? { replace: true, cleanup } : {}),
      ...resolved,
      intendedCommands,
      results,
      spawn,
      ...extra,
    });
    if (!ok) process.exit(1);
  };

  const argvFor = (i: number) => intendedSpawnCommands(resolved, ctx)[i].slice(1);

  const wtStep = runHerdr(herdr.bin, argvFor(0));
  results.push(wtStep);
  if (wtStep.status !== 0) {
    return finish(false, {
      error: "herdr worktree create failed",
      hint: "if a worktree/tab already exists for this task, re-run with --replace or `harness manager cleanup <taskId>` first",
    });
  }
  const wtResult = herdrResult(wtStep);
  ctx.workspaceId = wtResult?.workspace?.workspace_id;
  ctx.worktreePath = wtResult?.worktree?.path ?? resolved.task?.worktree?.path;
  if (ctx.workspaceId) spawn.workspaceId = ctx.workspaceId;
  if (ctx.worktreePath) spawn.worktreePath = ctx.worktreePath;
  if (wtResult?.tab?.tab_id) spawn.tabId = wtResult.tab.tab_id;
  saveSpawn(spawn);
  if (!ctx.workspaceId || !ctx.worktreePath) {
    return finish(false, {
      error: "could not parse worktree/workspace ids from herdr worktree create output",
    });
  }

  const tabStep = runHerdr(herdr.bin, argvFor(1));
  results.push(tabStep);
  if (tabStep.status !== 0) {
    return finish(false, { error: "herdr tab create failed" });
  }
  const tabResult = herdrResult(tabStep);
  ctx.paneId = tabResult?.root_pane?.pane_id;
  if (tabResult?.tab?.tab_id) spawn.tabId = tabResult.tab.tab_id;
  if (ctx.paneId) spawn.paneId = ctx.paneId;
  saveSpawn(spawn);
  if (!ctx.paneId) {
    return finish(false, {
      error: "could not parse pane id from herdr tab create output",
    });
  }

  const agentStep = runHerdr(herdr.bin, argvFor(2));
  results.push(agentStep);
  spawn.agentName = spec.name;
  saveSpawn(spawn);
  if (agentStep.status !== 0) {
    return finish(false, { error: "herdr agent start failed" });
  }
  finish(true, { agent: spec });
}

function cmdManagerCleanup() {
  const f = argvFlags(4);
  const execute = f.has("--execute");
  const force = f.has("--force");
  const taskId = positional(4)[0];
  if (!taskId) {
    printJson({ ok: false, error: "missing taskId", usage: ["harness manager cleanup <taskId> [--execute] [--force]"] });
    process.exit(1);
  }
  const resolved = resolveTask(taskId);
  const herdr = herdrUsable();
  const record = loadSpawns().spawns[taskId];
  const cleanupPlan = intendedCleanupCommands(record, force);

  if (!execute || !herdr.ok) {
    const why = !execute
      ? "default is dry-run; pass --execute to run cleanup"
      : herdr.reason;
    printJson({
      ok: true,
      mode: "dry-run",
      taskId,
      ...(resolved.error ? { configError: resolved.error } : { task: resolved.task }),
      previousSpawn: record ?? null,
      cleanup: { intendedCommands: cleanupPlan },
      herdr,
      skippedExecute: why,
    });
    return;
  }

  const cleanup = executeCleanup(taskId, resolved.error ? null : resolved, record, herdr, force);
  printJson({
    ok: cleanup.ok,
    mode: "executed",
    taskId,
    ...(resolved.error ? {} : { task: resolved.task }),
    previousSpawn: record ?? null,
    cleanup,
  });
  if (!cleanup.ok) process.exit(1);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(GATEWAY_PID_FILE)) return null;
  const n = Number(readFileSync(GATEWAY_PID_FILE, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function gatewayListening(): { pid: number | null; bind: ReturnType<typeof gatewayBind>; alive: boolean; lastEvent: unknown } {
  const pid = readPid();
  const alive = pid != null && pidAlive(pid);
  let bind = gatewayBind();
  if (existsSync(GATEWAY_META_FILE)) {
    try {
      const meta = JSON.parse(readFileSync(GATEWAY_META_FILE, "utf8"));
      if (meta.bind) bind = meta.bind;
    } catch {
      /* ignore */
    }
  }
  return { pid, bind, alive, lastEvent: lastIngress() };
}

async function waitHealth(bind: { hostname: string; port: number }, timeoutMs = 4000) {
  const url = `http://${bind.hostname}:${bind.port}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await Bun.sleep(80);
  }
  return false;
}

async function cmdGatewayStart() {
  const foreground = argvFlags(4).has("--foreground");
  const bind = gatewayBind();
  const current = gatewayListening();
  if (current.alive && !foreground) {
    printJson({
      ok: true,
      alreadyRunning: true,
      pid: current.pid,
      bind: current.bind,
      lastEvent: current.lastEvent,
    });
    return;
  }
  if (foreground) {
    const { startGatewayServer } = await import("./gateway.ts");
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(GATEWAY_PID_FILE, `${process.pid}\n`);
    startGatewayServer();
    return;
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn("bun", [join(ROOT, "src", "gateway.ts")], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
    cwd: process.cwd(),
  });
  if (child.pid == null) {
    printJson({ ok: false, error: "failed to spawn gateway" });
    process.exit(1);
  }
  child.unref();
  writeFileSync(GATEWAY_PID_FILE, `${child.pid}\n`);
  const ready = await waitHealth(bind);
  printJson({
    ok: ready,
    pid: child.pid,
    bind,
    listening: ready,
    alreadyRunning: false,
  });
  if (!ready) process.exit(1);
}

function cmdGatewayStatus() {
  const g = gatewayListening();
  printJson({
    ok: true,
    listening: g.alive,
    pid: g.pid,
    bind: g.bind,
    lastEvent: g.lastEvent,
    version: VERSION,
  });
}

function cmdGatewayStop() {
  const pid = readPid();
  if (pid == null || !pidAlive(pid)) {
    printJson({ ok: true, stopped: false, reason: "not running" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    printJson({ ok: false, error: String(e) });
    process.exit(1);
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && pidAlive(pid)) {
    spawnSync("sleep", ["0.05"]);
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  try {
    unlinkSync(GATEWAY_PID_FILE);
  } catch {
    /* ignore */
  }
  printJson({ ok: true, stopped: true, pid });
}

async function readJsonPayload(from: number): Promise<Record<string, unknown>> {
  const file = optValue("--file", from);
  const text = file
    ? readFileSync(file, "utf8")
    : await Bun.stdin.text();
  if (!text.trim()) {
    throw new Error("empty payload; pass --file PATH or JSON on stdin");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function cmdIssues() {
  const sub = process.argv[3];
  if (sub === "list") {
    const drafts = listIssueDrafts();
    printJson({ ok: true, playbook: PLAYBOOK_SENTRY, count: drafts.length, drafts });
    return;
  }
  if (sub === "ingest") {
    const source = (optValue("--source", 4) || positional(4)[0] || "") as string;
    if (source !== "sentry" && source !== "bugsink") {
      printJson({
        ok: false,
        error: "need --source sentry|bugsink",
      });
      process.exit(1);
    }
    try {
      const raw = await readJsonPayload(4);
      const draft = ingestErrorEvent(source, raw);
      printJson({
        ok: true,
        github: "not called (mock-draft)",
        playbook: PLAYBOOK_SENTRY,
        path: draft.path,
        draft,
      });
    } catch (e) {
      printJson({ ok: false, error: String(e) });
      process.exit(1);
    }
    return;
  }
  printJson({
    ok: false,
    error: sub ? `unknown issues subcommand: ${sub}` : "missing issues subcommand",
    usage: ["harness issues ingest --source sentry|bugsink [--file PATH]", "harness issues list"],
  });
  process.exit(1);
}

function loadIngressQueue(): Array<{ freeform?: boolean; taskId?: string | null; text?: string | null; at?: string; source?: string }> {
  if (!existsSync(INGRESS_QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(INGRESS_QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function cmdPick() {
  const { config } = loadConfig();
  const defaultAdapter = config?.adapters?.default ?? config?.agent ?? "grok-build";
  const drafts = listIssueDrafts().filter((d) => d.status === "mock-draft");
  const tasks = config?.tasks ?? [];
  const queue = loadIngressQueue();
  const prev = loadState();

  let chosen: {
    id: string;
    kind: "issue" | "task" | "freeform";
    adapter: string;
    reason: string;
    title?: string;
  } | null = null;

  if (drafts.length) {
    const d = drafts[0];
    chosen = {
      id: `issue:${d.fingerprint}`,
      kind: "issue",
      adapter: defaultAdapter,
      reason: "priority: mock issues first (desk:sentry-issues)",
      title: d.title,
    };
  } else if (tasks.length) {
    const lastId = prev.lastPicked?.kind === "task" ? prev.lastPicked.id : null;
    const idx = lastId ? tasks.findIndex((t) => t.id === lastId) : -1;
    const next = tasks[(idx + 1) % tasks.length];
    chosen = {
      id: next.id,
      kind: "task",
      adapter: next.adapter ?? defaultAdapter,
      reason: "priority: named tasks by list order (rotate after lastPicked)",
    };
  } else {
    const free = [...queue].reverse().find((e) => e.freeform);
    if (free) {
      chosen = {
        id: free.taskId || "freeform",
        kind: "freeform",
        adapter: defaultAdapter,
        reason: "priority: freeform ingress queue",
        title: free.text ?? undefined,
      };
    }
  }

  if (!chosen) {
    if (process.argv.includes("--json") || !process.stdout.isTTY) {
      printJson({ ok: false, error: "nothing to pick" });
    } else {
      console.error("nothing to pick");
    }
    process.exit(1);
  }

  const state = loadState();
  saveState({
    ...state,
    lastPicked: { id: chosen.id, kind: chosen.kind, adapter: chosen.adapter, at: new Date().toISOString() },
  });

  const json = { ok: true, ...chosen, rules: ["mock issues > named tasks by list order > freeform queue"] };
  if (process.argv.includes("--json") || !process.stdout.isTTY) {
    printJson(json);
    return;
  }
  console.log(`picked ${chosen.id} via ${chosen.adapter} (${chosen.kind})`);
  console.log(chosen.reason);
}

function cmdSummary() {
  const state = loadState();
  const { path: configPath, config } = loadConfig();
  const drafts = listIssueDrafts();
  const last = lastIngress();
  const gPid = existsSync(GATEWAY_PID_FILE)
    ? Number(readFileSync(GATEWAY_PID_FILE, "utf8").trim())
    : null;
  const json = {
    ok: true,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    session: {
      started: state.started,
      startedAt: state.startedAt ?? null,
      sessionId: state.sessionId ?? null,
      lastPicked: state.lastPicked ?? null,
    },
    configPath,
    playbooks: config?.playbooks ?? [],
    tasks: config?.tasks ?? [],
    gatewayLastEvent: last,
    gatewayPid: gPid,
    issueDrafts: drafts.map((d) => ({
      fingerprint: d.fingerprint,
      title: d.title,
      source: d.source,
      createdAt: d.createdAt,
      path: d.path,
    })),
  };

  if (process.argv.includes("--json")) {
    printJson(json);
    return;
  }

  const lines = [
    `# harness daily summary (on-demand)`,
    ``,
    `Generated: ${json.generatedAt}`,
    `Version: ${VERSION}`,
    ``,
    `## Session`,
    `- started: ${state.started} at ${state.startedAt ?? "—"}`,
    `- sessionId: ${state.sessionId ?? "—"}`,
    `- lastPicked: ${state.lastPicked ? `${state.lastPicked.id} (${state.lastPicked.kind})` : "—"}`,
    ``,
    `## Playbooks`,
    ...(config?.playbooks?.length
      ? config.playbooks.map((p) => `- \`${p.id}\` ${p.description ?? ""}`.trim())
      : [`- (none; bundled id \`${PLAYBOOK_SENTRY}\`)`]),
    ``,
    `## Mock issue drafts (${drafts.length}) — GitHub not called`,
    ...(!drafts.length
      ? ["- none"]
      : drafts.map((d) => `- ${d.createdAt} \`${d.fingerprint}\` ${d.title} (${d.path})`)),
    ``,
    `## Gateway last event`,
    last
      ? `- ${last.at} ${last.source} taskId=${last.taskId} freeform=${last.freeform}`
      : `- none`,
    ``,
    `No cron. Run \`harness summary\` when you want a report.`,
    ``,
  ];
  console.log(lines.join("\n"));
}

async function cmdGateway() {
  const sub = process.argv[3];
  if (sub === "start") return await cmdGatewayStart();
  if (sub === "status") return cmdGatewayStatus();
  if (sub === "stop") return cmdGatewayStop();
  printJson({
    ok: false,
    error: sub ? `unknown gateway subcommand: ${sub}` : "missing gateway subcommand",
    usage: ["harness gateway start [--foreground]", "harness gateway status", "harness gateway stop"],
  });
  process.exit(1);
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
  harness manager spawn <taskId>        Dry-run worktree+tab+agent spawn (--execute, --replace, --cleanup)
  harness manager cleanup <taskId>      Close spawned tab + remove worktree (--execute, --force)
  harness gateway start [--foreground]  Local HTTP ingress (default 127.0.0.1:8787)
  harness gateway status                Pid, bind, lastEvent
  harness gateway stop                  Stop background gateway
  harness issues ingest --source sentry|bugsink [--file PATH]
  harness issues list                   Mock GH issue drafts (no GitHub API)
  harness pick                          Next task: mock issues > config tasks > freeform
  harness summary                       On-demand markdown report (no cron)

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
  case "gateway":
    await cmdGateway();
    break;
  case "issues":
    await cmdIssues();
    break;
  case "pick":
    cmdPick();
    break;
  case "tasks":
    if (process.argv[3] === "pick") cmdPick();
    else {
      console.error("usage: harness tasks pick");
      process.exit(1);
    }
    break;
  case "summary":
    cmdSummary();
    break;
  case "report":
    if (process.argv[3] === "daily") cmdSummary();
    else {
      console.error("usage: harness report daily");
      process.exit(1);
    }
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
