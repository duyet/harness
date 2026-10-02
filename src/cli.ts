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
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ROOT,
  STATE_DIR,
  STATE_FILE,
  GATEWAY_PID_FILE,
  GATEWAY_META_FILE,
  INGRESS_QUEUE_FILE,
  LAST_SUMMARY_FILE,
  LAST_SUMMARY_JSON_FILE,
  LAST_DELIVERY_FILE,
  VERSION,
  RESTART_RESUME_HINT,
  CTRL_G_ACTION,
  CTRL_G_EXAMPLE_CONFIG,
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
  lastDelivery,
  writeFileAtomic,
  writeJsonAtomic,
  type State,
  type SpawnRecord,
  type LastDelivery,
} from "./shared.ts";
import { lastIngress } from "./gateway.ts";
import {
  ingestErrorEvent,
  listIssueDrafts,
  rankIssueDrafts,
  issueSeverity,
  ghIssueCreateArgv,
  publishIssueDraft,
} from "./issues.ts";

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
    ctrlGHint: {
      action: CTRL_G_ACTION,
      exampleConfig: CTRL_G_EXAMPLE_CONFIG,
      note: "plugins cannot declare keybindings; copy the example into ~/.config/herdr/config.toml",
    },
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
    console.log(`ctrl+g snippet:   ${CTRL_G_EXAMPLE_CONFIG}`);
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
  console.log(`ctrl+g snippet:   ${CTRL_G_EXAMPLE_CONFIG}`);
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

// Herdr's subprocess budget, deliberately separate from the chat and gh budgets
// so the three can be tuned independently. Every step is a local
// worktree/tab/agent operation, but `agent start` can be slow on a cold or
// loaded machine, so the default matches the gh network write at 60s rather
// than the chat budget's 10s.
export const HERDR_TIMEOUT_ENV = "HARNESS_HERDR_TIMEOUT_MS";
export const DEFAULT_HERDR_TIMEOUT_MS = 60_000;
export const MIN_HERDR_TIMEOUT_MS = 1_000;
export const MAX_HERDR_TIMEOUT_MS = 5 * 60_000;

export function herdrTimeoutMs(): number {
  const n = Number(process.env[HERDR_TIMEOUT_ENV]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HERDR_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), MIN_HERDR_TIMEOUT_MS), MAX_HERDR_TIMEOUT_MS);
}

// A bounded spawnSync that hits its timer reports ETIMEDOUT alongside the
// killSignal we asked for; a wedged child that only surfaced as SIGKILL counts
// too, since SIGKILL cannot be caught and escaped.
function herdrTimedOut(r: SpawnSyncReturns<string>): boolean {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ETIMEDOUT" || r.signal === "SIGKILL";
}

// stdin is ignored so herdr can never block on a terminal question there is
// nobody to answer, and SIGKILL so a wedged child actually dies.
function herdrSpawnOptions(timeoutMs: number) {
  return {
    encoding: "utf8" as const,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    killSignal: "SIGKILL" as const,
  };
}

function herdrUsable(): { ok: boolean; reason: string; bin: string } {
  const bin = herdrBin();
  const sock =
    process.env.HERDR_SOCKET ||
    join(homedir(), ".config", "herdr", "herdr.sock");
  // Bounded like every other herdr call: a probe that hangs must still be able
  // to say "not usable", which is exactly what it cannot do while wedged.
  const timeoutMs = herdrTimeoutMs();
  const probe = spawnSync(bin, ["--version"], herdrSpawnOptions(timeoutMs));
  if (herdrTimedOut(probe)) {
    return {
      ok: false,
      reason: `herdr binary not usable (${bin}): --version timed out after ${timeoutMs}ms`,
      bin,
    };
  }
  if (probe.error || probe.status !== 0) {
    return {
      ok: false,
      reason: `herdr binary not usable (${bin}): ${probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`}`,
      bin,
    };
  }
  // Only proves a socket *file* exists: a socket left behind by a crashed
  // herdr passes this gate and the next real call wedges. Bounding the
  // subprocess is what makes that recoverable; fixing the socket semantics is
  // deliberately out of scope.
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
  // Sorted by `at` so the listing is stable and diffable between runs. Ties keep
  // their insertion order, since Array#sort is stable.
  const spawns = Object.values(loadSpawns().spawns).sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
  printJson({
    ok: true,
    version: VERSION,
    configPath,
    name: config?.name ?? null,
    soul: config?.soul ?? null,
    defaultAdapter: config?.adapters?.default ?? config?.agent ?? null,
    adapters: config?.adapters?.routes ?? {},
    tasks: config?.tasks ?? [],
    spawns,
    spawnCount: spawns.length,
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
  // Optional and additive: `results` is printed verbatim into the JSON envelope
  // and existing consumers read only the four fields above.
  timedOut?: boolean;
};

// Every herdr call in the CLI goes through here, so bounding it bounds all of
// them. A timeout is an ordinary step failure — status stays null, the caller's
// existing "herdr ... failed" envelope and recovery hint handle it, and the
// timeout detail is folded into stderr so the operator can see why.
function runHerdr(herdrBin: string, args: string[]): HerdrStep {
  const timeoutMs = herdrTimeoutMs();
  const r = spawnSync(herdrBin, args, herdrSpawnOptions(timeoutMs));
  const timedOut = herdrTimedOut(r);
  const stderr = (r.stderr || "").trim();
  return {
    command: [herdrBin, ...args],
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: timedOut
      ? `${stderr ? `${stderr}; ` : ""}herdr timed out after ${timeoutMs}ms and was killed`
      : stderr,
    ...(timedOut ? { timedOut: true } : {}),
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

// Rows of a `tab list` / `worktree list` envelope, or null when the step did not
// succeed or the payload is not a list. Callers must never read a null as "empty":
// a wedged herdr and a quiet one are different states, and only the quiet one can
// prove that a cleanup already happened.
function readableList(step: HerdrStep, key: "tabs" | "worktrees"): any[] | null {
  if (step.status !== 0) return null;
  const rows = herdrResult(step)?.[key];
  return Array.isArray(rows) ? rows : null;
}

// Tab ids a listing still reports for this task, or null when it could not be read.
function taskTabIds(
  step: HerdrStep,
  record: SpawnRecord | undefined,
  label: string,
): string[] | null {
  const tabs = readableList(step, "tabs");
  if (!tabs) return null;
  return tabs
    .filter((t: any) => t?.tab_id === record?.tabId || t?.label === label)
    .map((t: any) => t.tab_id)
    .filter((id: any) => typeof id === "string");
}

// The worktree entry this task still owns, or null when none is listed (or the
// listing could not be read) — see taskTabIds for why those share a result.
function taskWorktree(
  step: HerdrStep,
  record: SpawnRecord | undefined,
  wt: Record<string, any>,
  wtLabel: string,
): any | null {
  const worktrees = readableList(step, "worktrees");
  if (!worktrees) return null;
  return (
    worktrees.find(
      (w: any) =>
        w?.open_workspace_id === record?.workspaceId ||
        w?.path === record?.worktreePath ||
        (wt.path && w?.path === wt.path) ||
        w?.label === wtLabel,
    ) ?? null
  );
}

// Ordered cleanup: list → close matching tab(s) → remove the worktree's
// workspace. Presence comes from live discovery; the persisted spawn record
// only supplies extra match hints and a fallback workspace id.
//
// `ok` answers "is the desired end state true now", never "did every command
// exit 0". A tab the user (or an earlier cleanup) already closed makes
// `tab close` exit nonzero even though the goal is met, and treating that as a
// failure pins the record in spawns.json forever: `manager spawn` then refuses
// with "task already spawned" and `--replace` dies at "cleanup before
// re-spawn failed". When a step does not confirm its own effect, re-listing is
// what distinguishes already-gone from still-there without also swallowing a
// genuine failure.
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
  const worktrees = readableList(wtStep, "worktrees");
  if (!readableList(tabsStep, "tabs") || !worktrees) {
    return { ok: false, error: "could not parse herdr list output", results };
  }

  const tabIds = taskTabIds(tabsStep, record, label)!;
  const wtMatch = taskWorktree(wtStep, record, wt, wtLabel);
  const workspaceId = wtMatch?.open_workspace_id ?? record?.workspaceId ?? null;

  const closedTabs: string[] = [];
  let undecided = false;
  for (const tabId of tabIds) {
    const r = runHerdr(herdr.bin, ["tab", "close", tabId]);
    results.push(r);
    if (r.status === 0) closedTabs.push(tabId);
    else undecided = true;
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
    else undecided = true;
  }

  // Every step exited 0, so each one already proved its own effect: a closed tab
  // is gone and a removed workspace is not listed. Only a step that failed to
  // confirm needs the world asked about it.
  let ok = !undecided;
  if (undecided) {
    const afterTabs = runHerdr(herdr.bin, ["tab", "list"]);
    results.push(afterTabs);
    const afterWorktrees = runHerdr(herdr.bin, ["worktree", "list", "--cwd", process.cwd()]);
    results.push(afterWorktrees);
    // A null listing fails this check rather than passing it: an unreadable list
    // is not an empty one, and an unconfirmed cleanup keeps its record.
    ok =
      taskTabIds(afterTabs, record, label)?.length === 0 &&
      readableList(afterWorktrees, "worktrees") !== null &&
      taskWorktree(afterWorktrees, record, wt, wtLabel) === null;
  }
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
  const record = taskId ? loadSpawns().spawns[taskId] : undefined;

  if (resolved.error) {
    printJson({
      ok: false,
      mode: "dry-run",
      ...resolved,
      intendedCommands,
      // Probing here would mean a subprocess on a path that has already failed
      // for a different reason; see the probe call below.
      herdr: null,
      todo: ["fix task id / config before spawn"],
    });
    process.exit(1);
  }

  // The documented default is dry-run, so the liveness probe is deferred until
  // `--execute` actually asks for herdr work. A wedged herdr must not be able to
  // hang a command that was never going to touch it.
  const herdr = execute ? herdrUsable() : null;

  if (!execute || !herdr?.ok) {
    const why = !execute || !herdr
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
        "Herdr is not probed on a dry run; the --version probe is deferred until --execute",
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

  // Echoable recovery commands for a spawn that failed after its first step.
  // Cleanup rediscovers tabs/worktrees live and only falls back to the record,
  // so it is best-effort: it can report `cleaned: false` and leave the record.
  const recoverFor = (task: string) => [
    `harness manager cleanup ${task} --execute`,
    `harness manager spawn ${task} --replace`,
  ];

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
      hint: "herdr exited 0 but its worktree/workspace ids were unreadable, so a worktree may be on disk and a partial record was saved; run `harness manager status` to see it, then re-run with --replace or `harness manager cleanup <taskId> --execute` (cleanup may not find an unparsed worktree)",
      recover: recoverFor(taskId!),
    });
  }

  const tabStep = runHerdr(herdr.bin, argvFor(1));
  results.push(tabStep);
  if (tabStep.status !== 0) {
    return finish(false, {
      error: "herdr tab create failed",
      hint: "the worktree was created before this step failed, so a worktree is on disk with no child tab; re-run with --replace or `harness manager cleanup <taskId> --execute` (cleanup reports `cleaned: false` if it finds nothing)",
      recover: recoverFor(taskId!),
    });
  }
  const tabResult = herdrResult(tabStep);
  ctx.paneId = tabResult?.root_pane?.pane_id;
  if (tabResult?.tab?.tab_id) spawn.tabId = tabResult.tab.tab_id;
  if (ctx.paneId) spawn.paneId = ctx.paneId;
  saveSpawn(spawn);
  if (!ctx.paneId) {
    return finish(false, {
      error: "could not parse pane id from herdr tab create output",
      hint: "the worktree and tab were created but the pane id was unreadable, so a worktree and tab are on disk with no agent; re-run with --replace or `harness manager cleanup <taskId> --execute` (cleanup may not match an unparsed pane)",
      recover: recoverFor(taskId!),
    });
  }

  const agentStep = runHerdr(herdr.bin, argvFor(2));
  results.push(agentStep);
  spawn.agentName = spec.name;
  saveSpawn(spawn);
  if (agentStep.status !== 0) {
    return finish(false, {
      error: "herdr agent start failed",
      hint: "the worktree and tab were created before this step failed, so a worktree and tab are on disk with no agent running; re-run with --replace or `harness manager cleanup <taskId> --execute` (cleanup closes the tab and removes the worktree if it finds them)",
      recover: recoverFor(taskId!),
    });
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
  const record = loadSpawns().spawns[taskId];
  const cleanupPlan = intendedCleanupCommands(record, force);
  // Deferred until --execute, for the same reason as in cmdManagerSpawn.
  const herdr = execute ? herdrUsable() : null;

  if (!execute || !herdr?.ok) {
    const why = !execute || !herdr
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

/**
 * Who, if anyone, is behind the pid in gateway.pid. A bare `kill(pid, 0)` only proves
 * *some* process holds that number — gateway.pid outlives a crash, so the OS eventually
 * recycles it onto unrelated user work. Every signal we send has to clear this first.
 */
type PidIdentity =
  | { kind: "gateway" }
  | { kind: "not-running" }
  | { kind: "recycled"; command: string | null };

type GatewayMeta = { pid?: unknown; bind?: ReturnType<typeof gatewayBind> };

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

/** gateway.json, written by the gateway process itself. Absent or corrupt is not a match. */
function readGatewayMeta(): GatewayMeta | null {
  if (!existsSync(GATEWAY_META_FILE)) return null;
  try {
    const meta = JSON.parse(readFileSync(GATEWAY_META_FILE, "utf8"));
    return meta && typeof meta === "object" ? (meta as GatewayMeta) : null;
  } catch {
    return null;
  }
}

function processCommand(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (raw) return raw;
  } catch {
    /* not readable here — fall back to ps */
  }
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 });
    if (r.status === 0) {
      const out = (r.stdout || "").trim();
      if (out) return out;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * A harness gateway is one of two processes: the detached `src/gateway.ts` that
 * `gateway start` spawns, or the CLI itself when `--foreground` serves in-process.
 */
function looksLikeGateway(command: string): boolean {
  if (command.includes("gateway.ts")) return true;
  const word = (w: string) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(command);
  return command.includes("cli.ts") && word("gateway") && word("start");
}

/**
 * Layered evidence, cheapest first. Step 1 can only refuse; confirming needs the command
 * line, so a missing or corrupt gateway.json falls through rather than counting as proof.
 * "Cannot verify" always resolves to `recycled` — a false refusal is recoverable, a false
 * match destroys an unrelated process.
 */
function pidIdentity(pid: number | null): PidIdentity {
  if (pid == null || !pidAlive(pid)) return { kind: "not-running" };
  const metaPid = readGatewayMeta()?.pid;
  if (typeof metaPid === "number" && Number.isFinite(metaPid) && metaPid !== pid) {
    return { kind: "recycled", command: processCommand(pid) };
  }
  const command = processCommand(pid);
  if (command == null || !looksLikeGateway(command)) return { kind: "recycled", command };
  return { kind: "gateway" };
}

function recycledReason(pid: number | null, command: string | null): string {
  const metaPid = readGatewayMeta()?.pid;
  const recorded = typeof metaPid === "number" && Number.isFinite(metaPid) ? String(metaPid) : "none";
  return `pid ${pid ?? "?"} is not a harness gateway (gateway.json pid: ${recorded}; running command: ${command ?? "unknown"})`;
}

function gatewayListening(): { pid: number | null; bind: ReturnType<typeof gatewayBind>; alive: boolean; lastEvent: unknown; lastDelivery: LastDelivery | null; identity?: PidIdentity } {
  const pid = readPid();
  const identity = pidIdentity(pid);
  let bind = gatewayBind();
  const metaBind = readGatewayMeta()?.bind;
  if (metaBind) bind = metaBind;
  // `alive` now means "a verified gateway", not "a live pid" — additive `identity` keeps
  // the refusal explainable without changing the fields existing consumers already read.
  return { pid, bind, alive: identity.kind === "gateway", lastEvent: lastIngress(), lastDelivery: lastDelivery(), identity };
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
      lastDelivery: current.lastDelivery,
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
  const identity = g.identity;
  const reason =
    identity?.kind === "recycled"
      ? recycledReason(g.pid, identity.command)
      : identity?.kind === "not-running"
        ? "not running"
        : null;
  printJson({
    ok: true,
    listening: g.alive,
    pid: g.pid,
    bind: g.bind,
    lastEvent: g.lastEvent,
    lastDelivery: g.lastDelivery,
    version: VERSION,
    ...(identity ? { identity } : {}),
    ...(reason ? { reason } : {}),
  });
}

function cmdGatewayStop() {
  const force = argvFlags(4).has("--force");
  const pid = readPid();
  const identity = pidIdentity(pid);
  if (pid == null || identity.kind === "not-running") {
    printJson({ ok: true, stopped: false, reason: "not running" });
    return;
  }
  if (identity.kind === "recycled" && !force) {
    const reason = recycledReason(pid, identity.command);
    // Clearing the stale file is the recovery: leaving it wedges `gateway start` forever.
    try {
      unlinkSync(GATEWAY_PID_FILE);
    } catch {
      /* ignore */
    }
    printJson({ ok: false, stopped: false, refused: true, pid, reason, removedPidFile: true });
    process.exit(1);
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
  // A terminal is never the source of a JSON payload. Reading one blocks
  // forever — no EOF, no timeout, no hint — and it is the same `stdin.text()`
  // hang class plan 009 closed one step downstream at `gh issue create`. The
  // refusal lands before any useful work, so without it an operator finds out
  // by sitting in a wedged terminal. Check before touching the stream.
  if (!file && process.stdin.isTTY) {
    throw new Error(
      "refusing to read the payload from a terminal; pass --file PATH or pipe JSON on stdin (e.g. `cat event.json | harness issues ingest --source sentry`)",
    );
  }
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
    const execute = argvFlags(4).has("--execute");
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
      if (!execute) {
        printJson({
          ok: true,
          mode: "dry-run",
          github: "not called (mock-draft)",
          intendedCommand: ["gh", ...ghIssueCreateArgv(draft)],
          playbook: PLAYBOOK_SENTRY,
          path: draft.path,
          draft,
        });
        return;
      }
      const result = publishIssueDraft(draft);
      printJson({
        ok: result.ok,
        mode: "executed",
        github: {
          command: result.command,
          status: result.status,
          ...(result.ok
            ? { url: result.url ?? null, issueNumber: result.issueNumber ?? null }
            : { error: result.error, stderr: result.stderr }),
        },
        playbook: PLAYBOOK_SENTRY,
        path: result.draft.path,
        draft: result.draft,
      });
      if (!result.ok) process.exit(1);
    } catch (e) {
      printJson({ ok: false, error: String(e) });
      process.exit(1);
    }
    return;
  }
  printJson({
    ok: false,
    error: sub ? `unknown issues subcommand: ${sub}` : "missing issues subcommand",
    usage: [
      "harness issues ingest --source sentry|bugsink [--file PATH] [--execute]",
      "harness issues list",
    ],
  });
  process.exit(1);
}

type IngressQueueEvent = {
  freeform?: boolean;
  taskId?: string | null;
  text?: string | null;
  at?: string;
  source?: string;
};

function loadIngressQueue(): IngressQueueEvent[] {
  if (!existsSync(INGRESS_QUEUE_FILE)) return [];
  try {
    // Parsing is not checking: `null`, `{}`, `[]` and `"x"` all come back from
    // `JSON.parse` and would escape the catch below, so the array check has to
    // be beside the parse. Without it a wrong-shaped queue reaches
    // `queue.filter(...)` in `cmdPick` and throws a raw TypeError out of the
    // command — the CLI's own equivalent of the gateway's 500.
    const parsed: unknown = JSON.parse(readFileSync(INGRESS_QUEUE_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as IngressQueueEvent[]) : [];
  } catch {
    return [];
  }
}

// Ordered pick priority, also exposed as `rules` in `pick --json` output.
const PICK_RULES = [
  "issue drafts first, then config tasks, then freeform ingress",
  "issues: only mock-draft is pickable work; github-created is never re-picked",
  "issues: higher severity level first (fatal > error > warning > info > other)",
  "issues: newer createdAt breaks severity ties",
  "issues: rotate down the ranked drafts after lastPicked; a cold start, or a draft that has since been published or evicted, takes the highest severity again",
  "tasks: rotate by list order after lastPicked; a cold start prefers tasks with a worktree stub",
  "freeform: rotate through freeform ingress events after lastPicked, keyed on the event's at timestamp rather than its position in the trimmed queue",
  "freeform: a cold start, or a cursor whose event has aged out of the queue, takes the most recent freeform event",
];

function cmdPick() {
  const { config } = loadConfig();
  const defaultAdapter = config?.adapters?.default ?? config?.agent ?? "grok-build";
  const drafts = rankIssueDrafts(
    listIssueDrafts().filter((d) => d.status === "mock-draft"),
  );
  const tasks = config?.tasks ?? [];
  const queue = loadIngressQueue();
  const prev = loadState();

  let chosen: {
    id: string;
    kind: "issue" | "task" | "freeform";
    adapter: string;
    reason: string;
    title?: string;
    severity?: string;
  } | null = null;
  // The freeform event's own `at`, recorded so the next pick can find that
  // event again. Undefined for every other kind, and for a timestamp-less
  // freeform event; the save below omits the field entirely in that case.
  let cursor: string | undefined;

  if (drafts.length) {
    // Rotation mirrors the task tier: `lastPicked` names the draft taken last,
    // and this pick starts one entry further down the *already ranked* list.
    // That moves the starting point only — `rankIssueDrafts` still owns the
    // order, so severity still dominates at every position.
    const lastId = prev.lastPicked?.kind === "issue" ? prev.lastPicked.id : null;
    const idx = lastId ? drafts.findIndex((d) => `issue:${d.fingerprint}` === lastId) : -1;
    // Cold start, or a cursor whose draft has since been published, evicted by
    // the bounded draft directory, or hand-deleted: fall back to the head of
    // the ranking. Computing `(idx + 1) % length` off a -1 would skip an entry
    // permanently, which is the bug this rotation exists to fix.
    const d = idx >= 0 ? drafts[(idx + 1) % drafts.length] : drafts[0];
    chosen = {
      id: `issue:${d.fingerprint}`,
      kind: "issue",
      adapter: defaultAdapter,
      severity: issueSeverity(d),
      reason: "priority: mock issue drafts by severity then recency (github-created drafts are skipped)",
      title: d.title,
    };
  } else if (tasks.length) {
    const lastId = prev.lastPicked?.kind === "task" ? prev.lastPicked.id : null;
    const idx = lastId ? tasks.findIndex((t) => t.id === lastId) : -1;
    // Cold start (no matching lastPicked task): prefer the first task that
    // declares a worktree stub, else fall back to plain list order.
    const next =
      idx >= 0
        ? tasks[(idx + 1) % tasks.length]
        : (tasks.find((t) => t.worktree) ?? tasks[0]);
    chosen = {
      id: next.id,
      kind: "task",
      adapter: next.adapter ?? defaultAdapter,
      reason:
        idx >= 0
          ? "priority: named tasks by list order (rotate after lastPicked)"
          : next.worktree
            ? "priority: cold-start task with a worktree stub"
            : "priority: named tasks by list order (rotate after lastPicked)",
    };
  } else {
    // Oldest to newest: the queue is append-only and `trimQueue` drops from the
    // front, so an index into it is not a stable handle — one new arrival
    // renumbers every position. The cursor is therefore the taken event's own
    // `at`, not its id: `free.taskId || "freeform"` records the literal string
    // "freeform" for any untagged event and identifies nothing at all.
    const freeform = queue.filter((e) => e.freeform);
    const lastAt = prev.lastPicked?.kind === "freeform" ? prev.lastPicked.eventAt : undefined;
    const idx = lastAt ? freeform.findIndex((e) => e.at === lastAt) : -1;
    // No cursor, or one whose event has aged out of the ring: take the newest,
    // which is what this tier has always done. `freeform[-1]` is undefined when
    // the queue holds no freeform event, so the "nothing to pick" path is intact.
    // Two events sharing one `at` are indistinguishable by construction; the
    // first match wins, so such a pair repeats rather than skipping either.
    const free = idx >= 0 ? freeform[(idx + 1) % freeform.length] : freeform[freeform.length - 1];
    if (free) {
      chosen = {
        id: free.taskId || "freeform",
        kind: "freeform",
        adapter: defaultAdapter,
        reason: "priority: freeform ingress queue",
        title: free.text ?? undefined,
      };
      // Only a timestamped event can be found again on the next pick; an `at`-
      // less entry records no cursor, so that pick falls back to the newest.
      if (free.at) cursor = free.at;
    }
  }

  if (!chosen) {
    if (process.argv.includes("--json") || !process.stdout.isTTY) {
      printJson({ ok: false, error: "nothing to pick", rules: PICK_RULES });
    } else {
      console.error("nothing to pick");
    }
    process.exit(1);
  }

  const state = loadState();
  saveState({
    ...state,
    lastPicked: {
      id: chosen.id,
      kind: chosen.kind,
      adapter: chosen.adapter,
      at: new Date().toISOString(),
      ...(cursor ? { eventAt: cursor } : {}),
    },
  });

  const json = { ok: true, ...chosen, rules: PICK_RULES };
  if (process.argv.includes("--json") || !process.stdout.isTTY) {
    printJson(json);
    return;
  }
  console.log(`picked ${chosen.id} via ${chosen.adapter} (${chosen.kind})`);
  console.log(chosen.reason);
}

// Human delivery stub: `harness summary --deliver` (or --write) persists the
// report under the state dir and records a lastDelivery blob that
// `harness gateway status` and /chat pickup can surface. No cron, no live
// Telegram/Matrix.
function writeSummaryDelivery(markdown: string, report: Record<string, unknown>): LastDelivery {
  const record: LastDelivery = {
    kind: "summary",
    at: new Date().toISOString(),
    summaryPath: LAST_SUMMARY_FILE,
    summaryJsonPath: LAST_SUMMARY_JSON_FILE,
    deliveryPath: LAST_DELIVERY_FILE,
    bytes: Buffer.byteLength(markdown, "utf8"),
    excerpt: markdown.slice(0, 600).trim(),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  // The three files are the record `harness summary`, `gateway status` and
  // /chat pickup all read back. A reader that catches a torn `last-delivery.json`
  // reports no delivery at all, and one that catches a torn markdown body shows
  // a summary that stops mid-sentence, so all three go through the atomic
  // writer rather than only the JSON half.
  writeFileAtomic(LAST_SUMMARY_FILE, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  writeJsonAtomic(LAST_SUMMARY_JSON_FILE, report);
  writeJsonAtomic(LAST_DELIVERY_FILE, record);
  return record;
}

function cmdSummary() {
  const state = loadState();
  const { path: configPath, config } = loadConfig();
  const drafts = listIssueDrafts();
  const last = lastIngress();
  const storedDelivery = lastDelivery();
  const gPid = existsSync(GATEWAY_PID_FILE)
    ? Number(readFileSync(GATEWAY_PID_FILE, "utf8").trim())
    : null;
  const generatedAt = new Date().toISOString();
  const json: Record<string, unknown> = {
    ok: true,
    version: VERSION,
    generatedAt,
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
    lastDelivery: storedDelivery,
    issueDrafts: drafts.map((d) => ({
      fingerprint: d.fingerprint,
      title: d.title,
      source: d.source,
      status: d.status,
      severity: issueSeverity(d),
      createdAt: d.createdAt,
      path: d.path,
    })),
  };

  const lines = [
    `# harness daily summary (on-demand)`,
    ``,
    `Generated: ${generatedAt}`,
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
    `## Issue drafts (${drafts.length})`,
    ...(!drafts.length
      ? ["- none"]
      : drafts.map((d) => `- ${d.createdAt} \`${d.fingerprint}\` [${d.status}] ${d.title} (${d.path})`)),
    ``,
    `## Gateway last event`,
    last
      ? `- ${last.at} ${last.source} taskId=${last.taskId} freeform=${last.freeform}`
      : `- none`,
    ``,
    `## Last delivery`,
    storedDelivery
      ? `- ${storedDelivery.at} → ${storedDelivery.summaryPath}`
      : `- none`,
    ``,
    `No cron. Run \`harness summary\` when you want a report.`,
    ``,
  ];
  const markdown = `${lines.join("\n")}\n`;

  const deliver = argvFlags().has("--deliver") || argvFlags().has("--write");
  if (deliver) {
    // The report body describes state at generation time; the new delivery
    // record becomes the stored lastDelivery from here on.
    const record = writeSummaryDelivery(markdown, json);
    json.lastDelivery = record;
    json.delivered = {
      summaryPath: record.summaryPath,
      summaryJsonPath: record.summaryJsonPath,
      deliveryPath: record.deliveryPath,
    };
  }

  if (process.argv.includes("--json")) {
    printJson(json);
    return;
  }
  console.log(markdown.replace(/\n$/, ""));
  if (deliver) console.log(`delivered: ${LAST_SUMMARY_FILE}`);
}

async function cmdGateway() {
  const sub = process.argv[3];
  if (sub === "start") return await cmdGatewayStart();
  if (sub === "status") return cmdGatewayStatus();
  if (sub === "stop") return cmdGatewayStop();
  printJson({
    ok: false,
    error: sub ? `unknown gateway subcommand: ${sub}` : "missing gateway subcommand",
    usage: ["harness gateway start [--foreground]", "harness gateway status", "harness gateway stop [--force]"],
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
  harness gateway stop                  Stop background gateway (--force overrides a recycled-pid refusal)
  harness issues ingest --source sentry|bugsink [--file PATH] [--execute]
                                        Mock draft by default; --execute runs real gh issue create
  harness issues list                   Issue drafts (mock or github-created)
  harness pick                          Next work: mock issues (severity) > tasks > freeform
  harness summary [--deliver|--write]   On-demand markdown report; --deliver writes
                                        last-summary.md/.json + last-delivery.json (no cron)

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
