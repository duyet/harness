import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  VERSION,
  ROOT,
  STATE_DIR,
  INGRESS_QUEUE_FILE,
  LAST_INGRESS_FILE,
  GATEWAY_META_FILE,
  loadConfig,
  resolveTask,
  gatewayBind,
  lastDelivery,
} from "./shared.ts";
import { ingestErrorEvent } from "./issues.ts";
import {
  chatAdapterArgv,
  chatExecuteEnabled,
  chatTimeoutMs,
  invokeAdapter,
} from "./chat.ts";

const CHAT_HTML = join(ROOT, "src", "static", "chat.html");

export type IngressEvent = {
  at: string;
  source: "matrix" | "telegram" | "chat";
  taskId: string | null;
  text: string | null;
  sender: string | null;
  channel: string | null;
  freeform: boolean;
  route: unknown;
  body: unknown;
};

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function persistIngress(event: IngressEvent) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LAST_INGRESS_FILE, `${JSON.stringify(event, null, 2)}\n`);
  const queue = readJsonFile<IngressEvent[]>(INGRESS_QUEUE_FILE, []);
  queue.push(event);
  const trimmed = queue.slice(-50);
  writeFileSync(INGRESS_QUEUE_FILE, `${JSON.stringify(trimmed, null, 2)}\n`);
  return { last: event, queued: trimmed.length };
}

function extractTaskId(raw: Record<string, unknown>, text: string | null): string | null {
  if (typeof raw.taskId === "string" && raw.taskId) return raw.taskId;
  if (typeof raw.task_id === "string" && raw.task_id) return raw.task_id;
  if (!text) return null;
  const m = text.match(/(?:task:|\/run)\s*([a-zA-Z0-9_.:-]+)/i);
  return m?.[1] ?? null;
}

function normalizeMatrix(raw: Record<string, unknown>) {
  const content = (raw.content as Record<string, unknown> | undefined) ?? {};
  const text =
    (typeof content.body === "string" && content.body) ||
    (typeof raw.body === "string" && raw.body) ||
    null;
  const sender = typeof raw.sender === "string" ? raw.sender : null;
  const channel = typeof raw.room_id === "string" ? raw.room_id : null;
  return { text, sender, channel, taskId: extractTaskId(raw, text) };
}

function normalizeTelegram(raw: Record<string, unknown>) {
  const message = (raw.message as Record<string, unknown> | undefined) ?? raw;
  const chat = (message.chat as Record<string, unknown> | undefined) ?? {};
  const from = (message.from as Record<string, unknown> | undefined) ?? {};
  const text =
    (typeof message.text === "string" && message.text) ||
    (typeof raw.text === "string" && raw.text) ||
    null;
  const sender =
    (typeof from.username === "string" && from.username) ||
    (from.id != null && String(from.id)) ||
    null;
  const channel = chat.id != null ? String(chat.id) : null;
  const nested = { ...raw, ...message };
  return { text, sender, channel, taskId: extractTaskId(nested, text) };
}

function normalizeChat(raw: Record<string, unknown>) {
  const text = typeof raw.text === "string" ? raw.text : typeof raw.body === "string" ? raw.body : null;
  return { text, sender: "chat-ui", channel: "local", taskId: extractTaskId(raw, text) };
}

export function handleIngress(source: "matrix" | "telegram" | "chat", raw: Record<string, unknown>) {
  const norm =
    source === "matrix"
      ? normalizeMatrix(raw)
      : source === "telegram"
        ? normalizeTelegram(raw)
        : normalizeChat(raw);
  const { config } = loadConfig();
  const defaultAdapter = config?.adapters?.default ?? config?.agent ?? "grok-build";
  let route: ReturnType<typeof resolveTask> | { error: string; defaultAdapter: string; freeform: true };
  let freeform = false;
  if (norm.taskId) {
    const resolved = resolveTask(norm.taskId);
    if (resolved.error) {
      freeform = true;
      route = { error: resolved.error, defaultAdapter, freeform: true };
    } else {
      route = resolved;
    }
  } else {
    freeform = true;
    route = { error: "freeform intent", defaultAdapter, freeform: true };
  }

  const event: IngressEvent = {
    at: new Date().toISOString(),
    source,
    taskId: norm.taskId,
    text: norm.text,
    sender: norm.sender,
    channel: norm.channel,
    freeform,
    route,
    body: raw,
  };
  const saved = persistIngress(event);
  const adapterId =
    !freeform && "adapterId" in route ? route.adapterId : defaultAdapter;
  const routeObj = !freeform && "route" in route ? route.route : null;

  return {
    ok: true,
    source,
    queued: saved.queued,
    task: {
      id: norm.taskId,
      text: norm.text,
      sender: norm.sender,
      channel: norm.channel,
      adapterId,
      freeform,
    },
    route: routeObj,
    lastEvent: event.at,
  };
}

function stubReply(result: ReturnType<typeof handleIngress>): string {
  const t = result.task;
  if (t.freeform) {
    return `stub: freeform via ${t.adapterId} — ${t.text ?? "(empty)"}`;
  }
  const kind = result.route && typeof result.route === "object" && "kind" in result.route
    ? String((result.route as { kind?: string }).kind)
    : t.adapterId;
  return `stub: routed task ${t.id} → adapter ${t.adapterId} (${kind}). No LLM.`;
}

// /chat replies: stub by default; with `"execute": true` in the body or
// HARNESS_CHAT_EXECUTE=1 the resolved adapter CLI runs as a short bounded
// subprocess. Any invoke failure still returns ok:true with mode:"stub" and
// an executeError field — the chat endpoint never hangs or 500s on adapters.
async function chatReply(
  result: ReturnType<typeof handleIngress>,
  raw: Record<string, unknown>,
) {
  const adapterId = result.task.adapterId;
  if (!chatExecuteEnabled(raw)) {
    return { mode: "stub" as const, reply: stubReply(result), adapterId };
  }
  const prompt =
    result.task.text ?? (result.task.id ? `task: ${result.task.id}` : "");
  const command = chatAdapterArgv(adapterId, result.route, prompt);
  const timeoutMs = chatTimeoutMs();
  const invoked = await invokeAdapter(command, timeoutMs);
  const execute = {
    command,
    timeoutMs,
    status: invoked.status,
    timedOut: invoked.timedOut,
    durationMs: invoked.durationMs,
  };
  if (invoked.ok) {
    return {
      mode: "executed" as const,
      reply: invoked.stdout || "(adapter exited 0 with no output)",
      adapterId,
      execute,
    };
  }
  return {
    mode: "stub" as const,
    reply: stubReply(result),
    adapterId,
    executeError: invoked.error ?? "adapter invoke failed",
    execute,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Summary pickup is opt-in per request: body `"pickup": true` (or "1"/"true"),
// a `?pickup=true|1` query flag, or the literal text `/summary`. Only stub
// replies are amended, so executed adapter replies stay untouched.
function chatPickupRequested(
  raw: Record<string, unknown>,
  url: URL,
  text: string | null,
): boolean {
  const flag = raw.pickup === true || raw.pickup === "true" || raw.pickup === "1";
  const query = url.searchParams.get("pickup");
  return flag || query === "true" || query === "1" || (text ?? "").trim() === "/summary";
}

type ParsedBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

async function parseJsonObject(req: Request): Promise<ParsedBody> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, response: Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }) };
  }
  if (!isRecord(parsed)) {
    return { ok: false, response: Response.json({ ok: false, error: "expected JSON object" }, { status: 400 }) };
  }
  return { ok: true, body: parsed };
}

function recordOr(
  value: unknown,
  missing: Record<string, unknown>,
): Record<string, unknown> | null {
  if (value == null) return missing;
  return isRecord(value) ? value : null;
}

function matrixShape(raw: Record<string, unknown>): boolean {
  return recordOr(raw.content, {}) !== null;
}

function telegramShape(raw: Record<string, unknown>): boolean {
  const message = recordOr(raw.message, raw);
  if (!message) return false;
  return recordOr(message.chat, {}) !== null && recordOr(message.from, {}) !== null;
}

function badPayload(): Response {
  return Response.json({ ok: false, error: "invalid payload shape" }, { status: 400 });
}

function chatPage(): Response {
  const html = existsSync(CHAT_HTML)
    ? readFileSync(CHAT_HTML, "utf8")
    : "<!doctype html><title>Harness chat</title><p>missing src/static/chat.html</p>";
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function lastIngress(): IngressEvent | null {
  return readJsonFile<IngressEvent | null>(LAST_INGRESS_FILE, null);
}

export async function handleGatewayRequest(req: Request, bind: ReturnType<typeof gatewayBind>): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/chat")) {
    return chatPage();
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, service: "harness-gateway", version: VERSION, bind });
  }
  if (req.method === "POST" && url.pathname === "/chat") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const result = handleIngress("chat", parsed.body);
    const reply = await chatReply(result, parsed.body);
    const body: Record<string, unknown> = {
      ok: true,
      ...reply,
      task: result.task,
      route: result.route,
      lastEvent: result.lastEvent,
      queued: result.queued,
    };
    if (reply.mode === "stub" && chatPickupRequested(parsed.body, url, result.task.text)) {
      const delivery = lastDelivery();
      body.lastSummary = delivery
        ? { at: delivery.at, path: delivery.summaryPath, excerpt: delivery.excerpt }
        : null;
      if (delivery) {
        body.reply = `${reply.reply}\n\nlast summary (${delivery.at}):\n${delivery.excerpt}`;
      }
    }
    return Response.json(body);
  }
  if (req.method === "GET" && url.pathname === "/status") {
    return Response.json({
      ok: true,
      listening: true,
      version: VERSION,
      bind,
      lastEvent: lastIngress(),
      lastDelivery: lastDelivery(),
    });
  }
  if (req.method === "POST" && url.pathname === "/ingress/matrix") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    if (!matrixShape(parsed.body)) return badPayload();
    const result = handleIngress("matrix", parsed.body);
    return Response.json(result, { status: 202 });
  }
  if (req.method === "POST" && url.pathname === "/ingress/telegram") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    if (!telegramShape(parsed.body)) return badPayload();
    const result = handleIngress("telegram", parsed.body);
    return Response.json(result, { status: 202 });
  }
  if (req.method === "POST" && url.pathname === "/ingress/sentry") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const draft = ingestErrorEvent("sentry", parsed.body);
    return Response.json({ ok: true, source: "sentry", queued: true, draft }, { status: 202 });
  }
  if (req.method === "POST" && url.pathname === "/ingress/bugsink") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const draft = ingestErrorEvent("bugsink", parsed.body);
    return Response.json({ ok: true, source: "bugsink", queued: true, draft }, { status: 202 });
  }
  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}

export function startGatewayServer() {
  const bind = gatewayBind();
  const server = Bun.serve({
    hostname: bind.hostname,
    port: bind.port,
    fetch(req) {
      return handleGatewayRequest(req, bind);
    },
  });
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    GATEWAY_META_FILE,
    `${JSON.stringify({ pid: process.pid, bind: { hostname: server.hostname, port: server.port }, version: VERSION }, null, 2)}\n`,
  );
  console.error(`harness gateway listening on http://${server.hostname}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startGatewayServer();
}
