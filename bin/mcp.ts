// Streamable-HTTP MCP endpoint for ESP32 Workbench.
// Single POST /mcp, JSON-only responses (no SSE), stateless. Reuses the same
// src/ functions and attach() handle the web UI uses. LAN-only: optional bearer
// token + Origin check guard it. See docs/mcp-implementation-plan.md.
import { activeSessions, attach, type Handle, type Subscriber } from "../src/serial.ts";
import { timingSafeEqual } from "node:crypto";

const PROTOCOL_VERSION = "2025-06-18";

export interface McpDeps {
  // Supplied by server.ts (they close over the rfc/mdns instances).
  portsWithRfc: () => Promise<unknown>;
  nvsToJson: (nvs: unknown) => unknown;
  token?: string; // optional bearer; if empty/undefined the endpoint is open
  allowedOrigins?: string[]; // optional Origin allowlist for browser clients
  version?: string;
}

class McpError extends Error {}

// --- auth ---------------------------------------------------------------

function tokenOk(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b); // keep timing roughly constant, then fail
    return false;
  }
  return timingSafeEqual(a, b);
}

// DNS-rebinding defence. Non-browser MCP clients send no Origin → allowed.
// A browser origin is only accepted if explicitly allowlisted.
function originOk(origin: string | null, allowed: string[] | undefined): boolean {
  if (!origin) return true;
  return !!allowed && allowed.includes(origin);
}

// --- device op helper ---------------------------------------------------

async function withDevice<T>(
  path: string,
  baud: number,
  force: boolean,
  fn: (h: Handle) => Promise<T>,
): Promise<T> {
  if (!path) throw new McpError("path is required");
  if (!force) {
    const busy = activeSessions().find((s) => s.path === path && s.subscribers > 0);
    if (busy) {
      throw new McpError(
        `port busy: console open on ${path} (${busy.subscribers} subscriber(s)); ` +
          `close it or pass force:true`,
      );
    }
  }
  const sub: Subscriber = { id: crypto.randomUUID(), onData: () => {}, onClose: () => {} };
  const h = await attach(path, baud, sub);
  try {
    return await fn(h);
  } finally {
    h.detach();
  }
}

// --- tools --------------------------------------------------------------

type Emit = (text: string) => void;

interface Tool {
  description: string;
  inputSchema: Record<string, unknown>;
  streaming?: boolean; // may stream chunks via emit before returning
  run: (args: Record<string, unknown>, emit?: Emit) => Promise<unknown>;
}

const num = (v: unknown, dflt: number) => (typeof v === "number" ? v : dflt);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const bool = (v: unknown) => v === true;

const DEVICE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Serial port path, e.g. /dev/tty.usbserial-0001" },
    baud: { type: "number", description: "Baud rate (default 115200)" },
    force: { type: "boolean", description: "Proceed even if a console is open on the port" },
  },
  required: ["path"],
};

// Passive live-console capture. Coexists with an open console (extra
// subscriber, no bootloader poke). Bounded so the stream always terminates.
async function readConsole(a: Record<string, unknown>, emit?: Emit) {
  const path = str(a.path);
  if (!path) throw new McpError("path is required");
  const existing = activeSessions().find((s) => s.path === path);
  const baud = num(a.baud, existing?.baudRate ?? 115200);
  const durationMs = Math.min(Math.max(num(a.duration_ms, 5000), 1), 60000);
  const maxBytes = Math.min(Math.max(num(a.max_bytes, 65536), 1), 1_048_576);
  const until = str(a.until);
  const dec = new TextDecoder();
  let text = "";
  let bytes = 0;
  let stoppedBy = "timeout";
  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const finish = (why: string) => {
    if (settled) return;
    settled = true;
    stoppedBy = why;
    resolveDone();
  };
  const sub: Subscriber = {
    id: crypto.randomUUID(),
    onData: (chunk) => {
      bytes += chunk.length;
      const piece = dec.decode(chunk, { stream: true });
      if (piece) {
        text += piece;
        emit?.(piece);
      }
      if (until && text.includes(until)) finish("match");
      else if (bytes >= maxBytes) finish("max_bytes");
    },
    onClose: () => finish("closed"),
  };
  const timer = setTimeout(() => finish("timeout"), durationMs);
  let h: Handle | undefined;
  try {
    h = await attach(path, baud, sub);
    await done;
  } finally {
    clearTimeout(timer);
    h?.detach();
  }
  return { text, bytes, stoppedBy };
}

function buildTools(deps: McpDeps): Record<string, Tool> {
  const toJson = (nvs: unknown) => (nvs ? deps.nvsToJson(nvs) : undefined);
  return {
    list_ports: {
      description: "List available serial ports (USB + RFC2217 network) with TCP assignments.",
      inputSchema: { type: "object", properties: {} },
      run: () => deps.portsWithRfc(),
    },
    list_sessions: {
      description: "List ports with active console sessions and their subscriber counts.",
      inputSchema: { type: "object", properties: {} },
      run: () => Promise.resolve(activeSessions()),
    },
    detect_chip: {
      description: "Probe the ROM bootloader for chip identity (type, MAC, revision, features). " +
        "Drives the bootloader — disruptive to an open console.",
      inputSchema: DEVICE_SCHEMA,
      run: (a) =>
        withDevice(str(a.path), num(a.baud, 115200), bool(a.force), (h) => h.detect()),
    },
    discover_device: {
      description: "One-pass discovery: chip info, partition table, OTA app slots, and NVS. " +
        "Drives the bootloader — disruptive to an open console.",
      inputSchema: DEVICE_SCHEMA,
      run: (a) =>
        withDevice(str(a.path), num(a.baud, 115200), bool(a.force), async (h) => {
          const scan = await h.scan();
          return {
            chip: scan.chip,
            flashSize: scan.flashSize,
            partitions: scan.partitions,
            apps: scan.apps,
            nvs: toJson(scan.nvs),
            nvsError: scan.nvsError,
          };
        }),
    },
    reset_device: {
      description: "Reset the device. Set bootloader:true to reset into ROM download mode.",
      inputSchema: {
        type: "object",
        properties: {
          path: DEVICE_SCHEMA.properties.path,
          baud: DEVICE_SCHEMA.properties.baud,
          force: DEVICE_SCHEMA.properties.force,
          bootloader: { type: "boolean", description: "Reset into ROM bootloader" },
        },
        required: ["path"],
      },
      run: (a) =>
        withDevice(str(a.path), num(a.baud, 115200), bool(a.force), async (h) => {
          await h.reset(bool(a.bootloader));
          return { ok: true, bootloader: bool(a.bootloader) };
        }),
    },
    enter_bootloader: {
      description: "Put the device into flash-download (bootloader) mode.",
      inputSchema: DEVICE_SCHEMA,
      run: (a) =>
        withDevice(str(a.path), num(a.baud, 115200), bool(a.force), async (h) => {
          await h.setFlashMode();
          return { ok: true };
        }),
    },
    read_console: {
      description: "Capture live serial console output for up to duration_ms (default 5000, max 60000), " +
        "or until the `until` substring appears. Passive — coexists with an open console. If the client " +
        "sends a progressToken the output streams incrementally over SSE; otherwise the collected text is returned.",
      streaming: true,
      inputSchema: {
        type: "object",
        properties: {
          path: DEVICE_SCHEMA.properties.path,
          baud: { type: "number", description: "Baud (defaults to the open session's baud, else 115200)" },
          duration_ms: { type: "number", description: "Max capture window in ms (default 5000, cap 60000)" },
          until: { type: "string", description: "Stop early when this substring appears" },
          max_bytes: { type: "number", description: "Stop after this many bytes (default 65536, cap 1048576)" },
        },
        required: ["path"],
      },
      run: (a, emit) => readConsole(a, emit),
    },
  };
}

// --- JSON-RPC dispatch --------------------------------------------------

interface RpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: RpcReq["id"], result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}
function rpcError(id: RpcReq["id"], code: number, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

// Streamable-HTTP SSE response: emit progress notifications while the tool
// runs, then the final JSON-RPC result, then close.
function streamToolCall(
  id: RpcReq["id"],
  tool: Tool,
  args: Record<string, unknown>,
  progressToken: unknown,
): Response {
  const enc = new TextEncoder();
  let progress = 0;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const out = await tool.run(args, (text) => {
          progress += text.length;
          send({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken, progress, message: text },
          });
        });
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: msg }], isError: true } });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

export function makeMcpHandler(deps: McpDeps) {
  const tools = buildTools(deps);
  const version = deps.version ?? "1.0.0";

  return async function handleMcp(req: Request): Promise<Response> {
    // Origin (DNS-rebinding) then auth, before we touch the body.
    if (!originOk(req.headers.get("origin"), deps.allowedOrigins)) {
      return new Response("forbidden origin", { status: 403 });
    }
    if (deps.token) {
      const auth = req.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!tokenOk(bearer, deps.token)) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
    }
    if (req.method !== "POST") {
      // We don't offer a server-initiated SSE stream (no GET stream) in v1.
      return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    let body: RpcReq;
    try {
      body = await req.json();
    } catch {
      return rpcError(null, -32700, "parse error", 400);
    }

    const { id, method, params } = body;

    // Notifications (no id) — ack per Streamable HTTP: 202, no body.
    if (id === undefined || id === null) {
      return new Response(null, { status: 202 });
    }

    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "ESP32 Workbench", version },
      });
    }

    if (method === "tools/list") {
      return rpcResult(id, {
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === "tools/call") {
      const name = str(params?.name);
      const tool = tools[name];
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const progressToken = (params?._meta as { progressToken?: unknown } | undefined)?.progressToken;
      if (tool.streaming && progressToken !== undefined) {
        return streamToolCall(id, tool, args, progressToken);
      }
      try {
        const out = await tool.run(args);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (err) {
        // Tool-execution failure → isError result, not a protocol error.
        const msg = err instanceof Error ? err.message : String(err);
        return rpcResult(id, { content: [{ type: "text", text: msg }], isError: true });
      }
    }

    return rpcError(id, -32601, `method not found: ${method ?? "(none)"}`);
  };
}
