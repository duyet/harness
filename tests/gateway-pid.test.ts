import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "src", "cli.ts");
const RUNNER = join(ROOT, "tests", "fixtures", "gateway-pid-runner.ts");
// Isolated from any gateway the developer may have running on the default port.
const PORT = "8799";
const HEALTH = `http://127.0.0.1:${PORT}/health`;

let fixture: ReturnType<typeof createFixture>;
const children: ChildProcess[] = [];

function cliEnv() {
  return { ...fixture.env, HARNESS_GATEWAY_PORT: PORT };
}

function stateDir() {
  return join(fixture.home, ".local", "state", "herdr-harness");
}

function pidPath() {
  return join(stateDir(), "gateway.pid");
}

function metaPath() {
  return join(stateDir(), "gateway.json");
}

function writePid(text: string) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(pidPath(), text);
}

function writeMeta(meta: unknown) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(metaPath(), typeof meta === "string" ? meta : `${JSON.stringify(meta)}\n`);
}

function runCli(args: string[]) {
  // Isolation is re-checked before every CLI invocation, not just once per test.
  fixture.assertIsolation();
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture.cwd,
    env: cliEnv(),
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  return { stdout: result.stdout, exit: result.status! };
}

function runRunner(args: string[]) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: fixture.cwd,
    env: cliEnv(),
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

/** The refusal path, observed from inside the CLI: which pids it signalled, and its exit. */
function stopSignals(...flags: string[]) {
  return runRunner(["signals", fixture.home, fixture.cwd, ...flags]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(pid)) await Bun.sleep(25);
  return !alive(pid);
}

/**
 * A long-lived process whose command line is the runner plus whatever argv we append, so a test
 * can pose any shape it wants `looksLikeGateway` to judge — and then hand its pid to the CLI as
 * a recycled one.
 */
function startChild(...argv: string[]) {
  const label = argv.join(" ") || "(bare)";
  return new Promise<{ pid: number; child: ChildProcess }>((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, "idle", fixture.home, fixture.cwd, ...argv], {
      cwd: fixture.cwd,
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`runner "${label}" never announced its pid`)), 10000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      resolve({ pid: JSON.parse(buf.slice(0, nl)).pid as number, child });
    });
    child.on("error", reject);
  });
}

/** Identity the CLI reports for `pid`, read through a real `gateway status`. */
function identityOf(pid: number): { kind: string; command?: string } {
  writePid(`${pid}\n`);
  const status = JSON.parse(runCli(["gateway", "status"]).stdout);
  expect(status.pid).toBe(pid);
  return status.identity;
}

function startSleep() {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  children.push(child);
  return child.pid!;
}

beforeEach(() => {
  fixture = createFixture();
  mkdirSync(stateDir(), { recursive: true });
});

afterEach(() => {
  // No case may leave a real gateway listening or a child unreaped.
  if (existsSync(pidPath())) {
    const pid = Number(readFileSync(pidPath(), "utf8").trim());
    if (Number.isFinite(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fixture?.cleanup();
});

describe("gateway pid identity", () => {
  test("characterizes the happy path: a real gateway is listening and stop still works", async () => {
    const started = runCli(["gateway", "start"]);
    expect(started.exit).toBe(0);
    const gatewayPid = Number(readFileSync(pidPath(), "utf8").trim());
    expect(Number.isInteger(gatewayPid)).toBe(true);
    expect(gatewayPid).toBeGreaterThan(0);

    const status = JSON.parse(runCli(["gateway", "status"]).stdout);
    expect(status).toMatchObject({ ok: true, listening: true, pid: gatewayPid, identity: { kind: "gateway" } });
    expect(status.reason).toBeUndefined();
    // The real detached argv this fix has to keep recognising: the entrypoint as an absolute
    // path, not the token-mentioning shapes the near-miss table below refuses.
    const realCmdline = readFileSync(`/proc/${gatewayPid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    expect(realCmdline).toContain(`${join(ROOT, "src", "gateway.ts")}`);

    const stopped = runCli(["gateway", "stop"]);
    expect(stopped.exit).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, stopped: true, pid: gatewayPid });
    expect(await waitDead(gatewayPid)).toBe(true);
  });

  test("refuses to signal a recycled pid, names the mismatch, and unblocks start", async () => {
    const decoy = startSleep();
    writePid(`${decoy}\n`);
    writeMeta({ pid: decoy + 1, bind: { hostname: "127.0.0.1", port: Number(PORT) } });
    expect(alive(decoy)).toBe(true);

    const status = JSON.parse(runCli(["gateway", "status"]).stdout);
    expect(status).toMatchObject({ ok: true, listening: false, pid: decoy, identity: { kind: "recycled" } });
    expect(status.identity.command).toContain("sleep 300");
    expect(status.reason).toContain(`pid ${decoy} is not a harness gateway`);
    expect(status.reason).toContain(`gateway.json pid: ${decoy + 1}`);
    expect(status.reason).toContain("sleep 300");

    const stopped = runCli(["gateway", "stop"]);
    expect(stopped.exit).toBe(1);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: false, stopped: false, refused: true, pid: decoy, removedPidFile: true });
    // The regression: an innocent process survived, and the stale file is gone.
    expect(alive(decoy)).toBe(true);
    expect(existsSync(pidPath())).toBe(false);

    // Same refusal, seen from inside the CLI: not one signal was attempted.
    writePid(`${decoy}\n`);
    expect(stopSignals()).toMatchObject({ exit: 1, signals: [] });
    expect(alive(decoy)).toBe(true);
  });

  test("a stale pid no longer wedges start: a real gateway comes up and health answers", async () => {
    const decoy = startSleep();
    writePid(`${decoy}\n`);

    const started = runCli(["gateway", "start"]);
    expect(started.exit).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ ok: true, listening: true, alreadyRunning: false });
    expect(alive(decoy)).toBe(true);

    const gatewayPid = Number(readFileSync(pidPath(), "utf8").trim());
    expect(gatewayPid).not.toBe(decoy);
    const health = await fetch(HEALTH).then((r) => r.json());
    expect(health).toMatchObject({ ok: true, service: "harness-gateway" });

    expect(runCli(["gateway", "stop"]).exit).toBe(0);
    expect(await waitDead(gatewayPid)).toBe(true);
  });

  test("gateway.json holding a different pid refuses even a gateway-shaped command line", async () => {
    // This process's cmdline names the gateway entrypoint, so only the pid/meta agreement layer
    // can refuse it — the command-line layer would wave it through.
    const lookalike = await startChild(join(ROOT, "src", "gateway.ts"));
    writePid(`${lookalike.pid}\n`);
    writeMeta({ pid: lookalike.pid + 1, bind: { hostname: "127.0.0.1", port: Number(PORT) } });

    const status = JSON.parse(runCli(["gateway", "status"]).stdout);
    expect(status).toMatchObject({ listening: false, identity: { kind: "recycled" } });
    expect(status.reason).toContain(`gateway.json pid: ${lookalike.pid + 1}`);

    expect(stopSignals()).toMatchObject({ exit: 1, signals: [] });
    expect(alive(lookalike.pid)).toBe(true);
  });

  test("a missing or corrupt gateway.json is never a match; the command line decides", async () => {
    const absent = await startChild(join(ROOT, "src", "gateway.ts"));
    writePid(`${absent.pid}\n`);
    expect(existsSync(metaPath())).toBe(false);
    // No meta to agree with, so the command line carries it: this one really is a gateway.
    const confirmed = JSON.parse(runCli(["gateway", "status"]).stdout);
    expect(confirmed).toMatchObject({ listening: true, identity: { kind: "gateway" } });
    expect(confirmed.reason).toBeUndefined();

    const corrupt = startSleep();
    writePid(`${corrupt}\n`);
    writeMeta("{ not json");
    const status = JSON.parse(runCli(["gateway", "status"]).stdout);
    expect(status).toMatchObject({ listening: false, identity: { kind: "recycled" } });
    expect(status.reason).toContain("gateway.json pid: none");
    expect(status.reason).toContain("sleep 300");
    expect(alive(corrupt)).toBe(true);
  });

  test("--force is the escape hatch that does signal a recycled pid", async () => {
    const decoy = startSleep();
    writePid(`${decoy}\n`);
    writeMeta({ pid: decoy + 1, bind: { hostname: "127.0.0.1", port: Number(PORT) } });
    expect(alive(decoy)).toBe(true);

    const stopped = runCli(["gateway", "stop", "--force"]);
    expect(stopped.exit).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, stopped: true, pid: decoy });
    expect(await waitDead(decoy)).toBe(true);
    expect(existsSync(pidPath())).toBe(false);
  });

  test("a malformed pid file is not-running: no signal, no throw, exit 0", () => {
    for (const raw of ["", "   \n", "-5", "0", "not-a-pid", "12 34", "3.7.1"]) {
      writePid(raw);

      const status = runCli(["gateway", "status"]);
      expect(status.exit).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ listening: false, identity: { kind: "not-running" }, reason: "not running" });

      const stopped = runCli(["gateway", "stop"]);
      expect(stopped.exit).toBe(0);
      expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, stopped: false, reason: "not running" });

      expect(stopSignals()).toMatchObject({ exit: 0, signals: [] });
    }
  });
});

/**
 * Plan 034. `looksLikeGateway` used to answer `command.includes("gateway.ts")` in its first
 * branch, so any process whose command line merely *mentioned* the entrypoint was `{kind:
 * "gateway"}` and `gateway stop` destroyed it with no `--force` and no refusal. The first
 * branch now asks for the token — and the absolute-path requirement is forced by the table
 * below: `bun src/gateway.ts` and `vim src/gateway.ts` are the same string.
 */
describe("looksLikeGateway tokenization (plan 034)", () => {
  const GATEWAY_ENTRYPOINT = join(ROOT, "src", "gateway.ts");
  const CLI_ENTRYPOINT = join(ROOT, "src", "cli.ts");

  test("both legitimate gateway shapes are still gateway — a rejections-only fix would fail here", async () => {
    // The detached spawn `gateway start` really performs.
    const detached = await startChild(GATEWAY_ENTRYPOINT);
    expect(identityOf(detached.pid).kind).toBe("gateway");

    // The `--foreground` shape: the CLI serving in-process as `… cli.ts gateway start`.
    const foreground = await startChild(CLI_ENTRYPOINT, "gateway", "start");
    expect(identityOf(foreground.pid).kind).toBe("gateway");

    // …and both are still *stoppable*, which is the half a rejections-only fix breaks. The
    // runner mocks process.kill, so this observes the signal rather than delivering it.
    for (const { pid } of [detached, foreground]) {
      expect(alive(pid)).toBe(true);
      writePid(`${pid}\n`);
      expect(stopSignals()).toMatchObject({ exit: 0, signals: [{ pid, signal: "SIGTERM" }] });
      expect(alive(pid)).toBe(true);
    }
  });

  test("a command line that merely mentions gateway.ts is recycled, not a match", async () => {
    // Each of these is accepted by `command.includes("gateway.ts")`. Every one is somebody
    // citing the entrypoint — an editor, a search, a log tail, a neighbouring file — and the
    // substring branch used to wave all of them through as the gateway itself.
    const table: [string, string[]][] = [
      ["editor, cwd-relative", ["vim", "src/gateway.ts"]],
      ["search, bare filename", ["grep", "-rn", "gateway.ts", "src/"]],
      ["pager, bare filename", ["less", "README.md", "gateway.ts"]],
      // /proc/<pid>/cmdline has no quotes, so this arrives as `… -p fix gateway.ts`.
      ["agent prompt, quoted", ["claude", "-p", "fix gateway.ts"]],
      ["log tail, token is a prefix", ["tail", "-f", "/var/log/gateway.ts.log"]],
      ["neighbouring file, longer extension", ["node", "gateway.tsx"]],
      ["backup, token is a prefix", ["gateway.ts.bak"]],
      ["token buried mid-element", ["/opt/gateway.ts.backup/run"]],
    ];

    const spawned: { pid: number }[] = [];
    for (const [_name, argv] of table) {
      // Precondition on the fixture itself: every row really does contain the substring, so
      // the table cannot pass vacuously against a matcher that never had to reject it.
      expect(argv.join(" ")).toContain("gateway.ts");
      spawned.push(await startChild(...argv));
    }

    for (const { pid } of spawned) {
      expect(identityOf(pid).kind).toBe("recycled");
      expect(alive(pid)).toBe(true);
    }
  }, 60000);

  test("gateway stop refuses a live process holding the token, and the process survives", async () => {
    // End to end through the real cmdGatewayStop: a pid file naming an unrelated process whose
    // command line carries the token, with no gateway.json to contradict it. Pre-034 this was
    // a `{kind:"gateway"}` match and the SIGKILL below landed.
    const victim = await startChild("vim", "src/gateway.ts");
    writePid(`${victim.pid}\n`);
    expect(existsSync(metaPath())).toBe(false);

    const status = JSON.parse(runCli(["gateway", "status"]).stdout);
    expect(status).toMatchObject({ ok: true, listening: false, pid: victim.pid, identity: { kind: "recycled" } });
    expect(status.reason).toContain(`pid ${victim.pid} is not a harness gateway`);

    const stopped = runCli(["gateway", "stop"]);
    expect(stopped.exit).toBe(1);
    // The same refusal shape the recycled-pid path already produced.
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      ok: false,
      stopped: false,
      refused: true,
      pid: victim.pid,
      removedPidFile: true,
    });
    expect(alive(victim.pid)).toBe(true);
    expect(existsSync(pidPath())).toBe(false);

    // Nothing was even attempted, seen from inside the CLI.
    writePid(`${victim.pid}\n`);
    expect(stopSignals()).toMatchObject({ exit: 1, signals: [] });
    expect(alive(victim.pid)).toBe(true);
  });

  test("an absent or a corrupt gateway.json still refuses — the command line is the only guard", async () => {
    // This is 034's precondition, and it is the *ordinary* case: gateway.json is written only
    // after Bun.serve succeeds, so a crashed or never-bound gateway leaves a bare pid file and
    // the command-line layer standing alone between a recycled pid and a SIGKILL.
    const absent = await startChild("grep", "-rn", "gateway.ts", "src/");
    writePid(`${absent.pid}\n`);
    expect(existsSync(metaPath())).toBe(false);
    expect(identityOf(absent.pid).kind).toBe("recycled");
    expect(runCli(["gateway", "stop"]).exit).toBe(1);
    expect(alive(absent.pid)).toBe(true);

    const corrupt = await startChild("claude", "-p", "fix gateway.ts");
    writePid(`${corrupt.pid}\n`);
    writeMeta("{ not json");
    const status = JSON.parse(runCli(["gateway", "status"]).stdout);
    expect(status).toMatchObject({ listening: false, identity: { kind: "recycled" } });
    expect(status.reason).toContain("gateway.json pid: none");
    expect(runCli(["gateway", "stop"]).exit).toBe(1);
    expect(alive(corrupt.pid)).toBe(true);
  });

  test("--force is still available for a token-holding process, and still signals it", async () => {
    const victim = await startChild("vim", "src/gateway.ts");
    writePid(`${victim.pid}\n`);

    const stopped = runCli(["gateway", "stop", "--force"]);
    expect(stopped.exit).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, stopped: true, pid: victim.pid });
    expect(await waitDead(victim.pid)).toBe(true);
  });
});