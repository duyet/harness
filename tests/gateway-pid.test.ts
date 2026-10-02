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

/** A long-lived unrelated process, so its pid can stand in for a recycled one. */
function startChild(label: string) {
  return new Promise<{ pid: number; child: ChildProcess }>((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, label, fixture.home, fixture.cwd], {
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
    expect(status).toMatchObject({ ok: true, listening: true, pid: gatewayPid });
    expect(status.reason).toBeUndefined();

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
    // This process's cmdline contains `gateway.ts`, so only the pid/meta agreement layer
    // can refuse it — the command-line layer would wave it through.
    const lookalike = await startChild("gateway.ts");
    writePid(`${lookalike.pid}\n`);
    writeMeta({ pid: lookalike.pid + 1, bind: { hostname: "127.0.0.1", port: Number(PORT) } });

    const status = JSON.parse(runCli(["gateway", "status"]).stdout);
    expect(status).toMatchObject({ listening: false, identity: { kind: "recycled" } });
    expect(status.reason).toContain(`gateway.json pid: ${lookalike.pid + 1}`);

    expect(stopSignals()).toMatchObject({ exit: 1, signals: [] });
    expect(alive(lookalike.pid)).toBe(true);
  });

  test("a missing or corrupt gateway.json is never a match; the command line decides", async () => {
    const absent = await startChild("gateway.ts");
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