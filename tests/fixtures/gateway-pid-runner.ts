import { strict as assert } from "node:assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spyOn } from "bun:test";

// argv: <label> <home> <cwd> [extra `gateway stop` flags...]
//
// decoy      — a long-lived process that is NOT a gateway. Its command line fails the
//              gateway marker check, so the command-line layer alone must refuse it.
// gateway.ts  — identical behaviour, but the label makes the process command line contain
//              the gateway entrypoint. Only the gateway.json/pid agreement check can
//              refuse it, which is what isolates that layer.
// signals     — runs the real `harness gateway stop` in-process with process.kill recorded
//              and process.exit trapped, and reports every signal it attempted.
const label = process.argv[2];
const home = process.argv[3];
const cwd = process.argv[4];

function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}

assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
const { STATE_DIR } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));

if (label === "decoy" || label === "gateway.ts") {
  // Stay alive as the plausible unrelated process a stale pid file could name.
  console.log(JSON.stringify({ pid: process.pid, label }));
  await new Promise(() => {});
} else if (label === "signals") {
  const signals: { pid: number; signal: string }[] = [];
  let delivered = false;
  spyOn(process, "kill").mockImplementation(((target: number | string, sig: number | string) => {
    const signal = String(sig);
    if (signal === "0") {
      // A liveness probe: the target is gone once something has been signalled to it.
      if (delivered) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    }
    signals.push({ pid: Number(target), signal });
    delivered = true;
    return true;
  }) as typeof process.kill);

  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };

  let exit: number | null = null;
  spyOn(process, "exit").mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error(`__exit__${exit}`);
  }) as never);

  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  process.argv = [process.execPath, cli, "gateway", "stop", ...process.argv.slice(5)];
  try {
    await import(cli);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit__")) throw e;
  }
  console.log = realLog;
  realLog(JSON.stringify({ signals, exit: exit ?? 0, printed }));
} else {
  unexpected(`unknown runner label: ${label}`);
}