import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  VERSION,
  STATE_DIR,
  INGRESS_QUEUE_FILE,
  LAST_INGRESS_FILE,
  GATEWAY_META_FILE,
  loadConfig,
  resolveTask,
  gatewayBind,
} from "./shared.ts";

export type IngressEvent = {
  at: string;
  source: "matrix" | "telegram";
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

export function handleIngress(source: "matrix" | "telegram", raw: Record<string, unknown>) {
  const norm = source === "matrix" ? normalizeMatrix(raw) : normalizeTelegram(raw);
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

export function lastIngress(): IngressEvent | null {
  return readJsonFile<IngressEvent | null>(LAST_INGRESS_FILE, null);
}

export function startGatewayServer() {
  const bind = gatewayBind();
  const server = Bun.serve({
    hostname: bind.hostname,
    port: bind.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return Response.json({ ok: true, service: "harness-gateway", version: VERSION, bind });
      }
      if (req.method === "GET" && url.pathname === "/status") {
        return Response.json({
          ok: true,
          listening: true,
          version: VERSION,
          bind,
          lastEvent: lastIngress(),
        });
      }
      if (req.method === "POST" && url.pathname === "/ingress/matrix") {
        const body = (await req.json()) as Record<string, unknown>;
        const result = handleIngress("matrix", body);
        return Response.json(result, { status: 202 });
      }
      if (req.method === "POST" && url.pathname === "/ingress/telegram") {
        const body = (await req.json()) as Record<string, unknown>;
        const result = handleIngress("telegram", body);
        return Response.json(result, { status: 202 });
      }
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
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
