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
  type State,
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
  const ok = results.every((r) => r.status === 0);
  printJson({
    ok,
    mode: "executed",
    ...resolved,
    intendedCommands,
    results,
    todo: ["tab/agent create after worktree is still a stub"],
  });
  if (!ok) process.exitCode = 1;
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
  harness manager spawn <taskId>        Dry-run worktree spawn (--execute to try herdr)
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
