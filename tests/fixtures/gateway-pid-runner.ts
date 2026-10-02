import { strict as assert } from "node:assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spyOn } from "bun:test";

// argv: <role> <home> <cwd> [...extra]
//
// idle      — a long-lived process whose command line is `bun <this file> idle <home> <cwd>`
//              plus whatever argv the caller appended. That tail is what /proc/<pid>/cmdline
//              hands `looksLikeGateway`, so a caller can pose any argv shape it wants to be
//              judged on — an editor, a grep, a `tail -f`, or the real entrypoint path —
//              without this file ever matching it itself.
// signals   — runs the real `harness gateway stop` in-process with process.kill recorded
//              and process.exit trapped, and reports every signal it attempted. Its extra
//              argv is the `gateway stop` flags.
const role = process.argv[2];
const home = process.argv[3];
const cwd = process.argv[4];

function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}

assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
const { STATE_DIR } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));

if (role === "idle") {
  // Stay alive as the plausible unrelated process a stale pid file could name.
  console.log(JSON.stringify({ pid: process.pid }));
  await new Promise(() => {});
} else if (role === "signals") {
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
  unexpected(`unknown runner role: ${role}`);
}