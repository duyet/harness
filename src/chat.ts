import { spawn } from "node:child_process";
import type { AdapterRoute, HarnessConfig } from "./shared.ts";

export const CHAT_EXECUTE_ENV = "HARNESS_CHAT_EXECUTE";
export const CHAT_ALLOW_REMOTE_ENV = "HARNESS_CHAT_ALLOW_REMOTE";
export const CHAT_ALLOW_ORIGIN_ENV = "HARNESS_CHAT_ALLOW_ORIGIN";
export const CHAT_TIMEOUT_ENV = "HARNESS_CHAT_TIMEOUT_MS";
// The .herdr-harness.json key that allowlists extra executable route kinds.
export const CHAT_EXECUTE_KINDS_CONFIG_KEY = "adapters.chat.executeKinds";
export const DEFAULT_CHAT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_PROMPT_CHARS = 4_000;

// Best-effort non-interactive args for known agent kinds. Unknown kinds run
// the bare binary; failure falls back to the stub reply either way.
const NONINTERACTIVE_ARGS: Record<string, string[]> = {
  claude: ["-p"],
  codex: ["exec"],
  gemini: ["-p"],
  grok: ["-p"],
  opencode: ["run"],
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Shared truthy env-flag semantics for every chat opt-in below.
export function chatEnvEnabled(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

export function chatExecuteEnabled(raw: Record<string, unknown>): boolean {
  const field =
    raw.execute === true || raw.execute === "true" || raw.execute === "1";
  return field || chatEnvEnabled(CHAT_EXECUTE_ENV);
}

// Route kinds that are allowed to run without being named in the config.
// Built-in kinds are the agent CLIs in NONINTERACTIVE_ARGS.
export const CHAT_BUILTIN_KINDS: readonly string[] = Object.keys(NONINTERACTIVE_ARGS);

// Execute is default-deny on the route kind: the repository's config names the
// binary, and an unlisted kind must never reach spawn(). A kind is allowed when
// it is a built-in non-interactive agent CLI, or when the config lists it under
// adapters.chat.executeKinds. Widening executeKinds is a security decision.
export function chatKindAllowed(
  kind: string,
  config: HarnessConfig | null,
): boolean {
  if (!kind) return false;
  // Own-property only: a route kind of "constructor" must not match the
  // prototype chain and slip through as allowlisted.
  if (Object.hasOwn(NONINTERACTIVE_ARGS, kind)) return true;
  const extra = config?.adapters?.chat?.executeKinds;
  if (!Array.isArray(extra)) return false;
  return extra.some((k) => typeof k === "string" && k === kind);
}

// The kind chatAdapterArgv puts at argv[0]; the gate and the argv builder must
// agree on it, so both derive it here. argv shape is unchanged.
export function chatAdapterKind(
  adapterId: string,
  route: AdapterRoute | null,
): string {
  return route?.kind || adapterId;
}

export function chatTimeoutMs(): number {
  const n = Number(process.env[CHAT_TIMEOUT_ENV]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHAT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), 100), MAX_TIMEOUT_MS);
}

// Mirrors agentSpec()'s launch shape: route kind is the binary, `via` is a
// leading subcommand, then model/flags, then the chat text as the final arg.
export function chatAdapterArgv(
  adapterId: string,
  route: AdapterRoute | null,
  prompt: string,
): string[] {
  const kind = chatAdapterKind(adapterId, route);
  const argv = [
    kind,
    ...(route?.via ? [route.via] : []),
    ...(NONINTERACTIVE_ARGS[kind] ?? []),
    ...(route?.model ? ["--model", route.model] : []),
    ...(route?.flags ?? []),
  ];
  const trimmed = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (trimmed) argv.push(trimmed);
  return argv;
}

export type InvokeResult = {
  ok: boolean;
  stdout: string;
  status: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
};

export function invokeAdapter(
  argv: string[],
  timeoutMs = DEFAULT_CHAT_TIMEOUT_MS,
): Promise<InvokeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        ok: false,
        stdout: "",
        status: null,
        timedOut: false,
        durationMs: Date.now() - started,
        error: `spawn failed: ${errText(e)}`,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<InvokeResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });
    child.on("error", (e) => {
      finish({
        ok: false,
        stdout: "",
        status: null,
        timedOut,
        error: `spawn failed: ${errText(e)}`,
      });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({
          ok: false,
          stdout: "",
          status: code,
          timedOut: true,
          error: `timed out after ${timeoutMs}ms`,
        });
      } else if (code === 0) {
        finish({ ok: true, stdout: stdout.trim(), status: 0, timedOut: false });
      } else {
        const detail = stderr.trim().slice(0, 500);
        finish({
          ok: false,
          stdout: "",
          status: code,
          timedOut: false,
          error: `exit ${code}${detail ? `: ${detail}` : ""}`,
        });
      }
    });
  });
}
