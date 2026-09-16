import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = join(ROOT, "tests", "fixtures", "gateway-context-runner.ts");
const TASK = "fixture-context-task";
const ADAPTER = "fixture-context-adapter";
const ROUTE = { kind: "fixture-context", via: "fixture-only" };
let fixture: ReturnType<typeof createFixture>;
let nested: string;

function run(mode: string, cwd: string) {
  const result = spawnSync(process.execPath, [RUNNER, mode, fixture.home, cwd], {
    cwd,
    env: fixture.env,
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

function captureLaunch() {
  const stateDir = join(fixture.home, ".local", "state", "herdr-harness");
  const pidFile = join(stateDir, "gateway.pid");
  const captureFile = join(fixture.root, "gateway-launch.json");
  expect(existsSync(pidFile)).toBe(false);
  expect(existsSync(captureFile)).toBe(false);
  const response = run("launch", nested);
  const captured = JSON.parse(readFileSync(captureFile, "utf8"));
  expect(captured.cwd).toBe(nested);
  expect(captured.args).toEqual([join(ROOT, "src", "gateway.ts")]);
  expect(isAbsolute(captured.args[0])).toBe(true);
  expect(resolve(captured.args[0])).not.toBe(join(fixture.cwd, "src", "gateway.ts"));
  expect(captured.home).toBe(fixture.home);
  expect(captured.tmp).toBe(fixture.tmp);
  expect(captured.herdr).toBe(fixture.env.HERDR_BIN_PATH);
  expect(Number.isInteger(captured.pid)).toBe(true);
  expect(captured.pid).toBeGreaterThan(0);
  expect(readFileSync(pidFile, "utf8")).toBe(`${captured.pid}\n`);
  // Health is stubbed: this is launch-contract coverage, not a live daemon.
  expect(response).toMatchObject({ ok: true, listening: true, alreadyRunning: false, pid: captured.pid });
  expect(existsSync(join(stateDir, "gateway.json"))).toBe(false);
  expect(existsSync(join(stateDir, "ingress-queue.json"))).toBe(false);
  return captured;
}

function routeFrom(cwd: string) {
  const routed = run("route", cwd);
  const stateDir = join(fixture.home, ".local", "state", "herdr-harness");
  expect(routed.cwd).toBe(nested);
  expect(routed.home).toBe(fixture.home);
  expect(routed.stateDir).toBe(stateDir);
  expect(routed.configPath).toBe(join(fixture.cwd, ".herdr-harness.json"));
  expect(routed.result).toMatchObject({
    ok: true,
    task: { id: TASK, adapterId: ADAPTER, freeform: false },
    route: ROUTE,
  });
  const event = JSON.parse(readFileSync(join(stateDir, "last-ingress.json"), "utf8"));
  expect(event.route).toMatchObject({
    configPath: routed.configPath,
    task: { id: TASK, adapter: ADAPTER },
    adapterId: ADAPTER,
    route: ROUTE,
  });
  expect(existsSync(join(stateDir, "gateway.json"))).toBe(false);
  return routed.result;
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  nested = join(fixture.cwd, "packages", "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify({
    adapters: { default: "fixture-default", routes: { [ADAPTER]: ROUTE } },
    tasks: [{ id: TASK, adapter: ADAPTER }],
  }));
});

afterEach(() => {
  fixture?.cleanup();
});

describe("gateway caller context", () => {
  test("captures caller cwd and absolute script through an isolated PATH shim", () => {
    captureLaunch();
  });

  test("routes from captured background context with foreground-equivalent parity", () => {
    const captured = captureLaunch();
    const background = routeFrom(captured.cwd);
    const foreground = routeFrom(nested);
    expect(background.task).toEqual(foreground.task);
    expect(background.route).toEqual(foreground.route);
    expect(background.queued).toBe(1);
    expect(foreground.queued).toBe(2);
  });
});
