#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env --allow-run --allow-sys --node-modules-dir
import { Eta } from "eta";
import { listPorts, type PortInfo, PortWatcher } from "../src/ports.ts";
import { activeSessions, attach } from "../src/serial.ts";
import { Rfc2217Manager } from "../src/rfc2217.ts";
import { MdnsManager } from "../src/mdns.ts";
import type { NvsParseResult } from "../src/nvs-parse.ts";
import { LogWriter, resolveDefaultLogDir } from "../src/session-log.ts";
import { makeMcpHandler } from "./mcp.ts";

const CP210X_WRITE_SCRIPT = new URL("./cp210x-write-serial.js", import.meta.url).pathname;

async function runCp210xWriteSerial(
  vidHex: string,
  pidHex: string,
  currentSerial: string,
  newValue: string,
  field: "serial" | "product" = "serial",
): Promise<{ ok: boolean; wrote?: string; field?: string; error?: string; platformHint?: string }> {
  try {
    const cmd = new Deno.Command("node", {
      args: [CP210X_WRITE_SCRIPT, vidHex, pidHex, currentSerial || "-", newValue, field],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout, stderr, code } = await cmd.output();
    const out = new TextDecoder().decode(stdout).trim();
    const err = new TextDecoder().decode(stderr).trim();
    const lastLine = out.split("\n").filter(Boolean).pop() ?? "";
    try {
      const parsed = JSON.parse(lastLine);
      return parsed;
    } catch {
      return {
        ok: false,
        error: `cp210x subprocess exited ${code}; stdout=${out.slice(0, 200)}; stderr=${err.slice(0, 200)}`,
      };
    }
  } catch (err) {
    return { ok: false, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function parseFlashSizeStr(s: string | undefined): number | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+)\s*(KB|MB|GB|B)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "MB").toUpperCase();
  if (unit === "B") return n;
  if (unit === "KB") return n * 1024;
  if (unit === "MB") return n * 1024 * 1024;
  if (unit === "GB") return n * 1024 * 1024 * 1024;
  return null;
}

function nvsToJson(nvs: NvsParseResult) {
  return {
    activePages: nvs.activePages,
    totalPages: nvs.totalPages,
    notes: nvs.notes,
    namespaces: nvs.namespaces.map((ns) => ({
      name: ns.name,
      index: ns.index,
      entries: ns.entries.map((e) => {
        let value: string | number | Array<number>;
        let preview: string | undefined;
        if (typeof e.value === "bigint") value = e.value.toString();
        else if (e.value instanceof Uint8Array) {
          const n = e.value.length;
          const head = Array.from(e.value.slice(0, 32)).map((b) => b.toString(16).padStart(2, "0")).join("");
          preview = n > 32 ? `${head}… (${n} B)` : `${head} (${n} B)`;
          value = preview;
        } else value = e.value as string | number;
        return { key: e.key, type: e.type, value, size: e.size };
      }),
    })),
  };
}

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const TEMPLATES_DIR = new URL("../assets/templates/", import.meta.url).pathname;
const PORT = Number(Deno.env.get("PORT") ?? 4000);
const IS_DEV = (Deno.env.get("NODE_ENV") ?? "development") !== "production";
const BS_PORT = Number(Deno.env.get("BROWSER_SYNC_PORT") ?? 3000);

const eta = new Eta({ views: TEMPLATES_DIR, cache: !IS_DEV });
const RFC_HOST = Deno.env.get("RFC2217_HOST") ?? "0.0.0.0";
const MDNS_DISABLED = Deno.env.get("MDNS_DISABLED") === "1" ||
  Deno.args.includes("--no-mdns");
const LOG_DIR = Deno.env.get("IOT_LOG_DIR") ?? resolveDefaultLogDir();
const LOG_MAX_BYTES = Number(Deno.env.get("IOT_LOG_MAX_BYTES") ?? 5 * 1024 * 1024);
const LOG_RING_BYTES = 128 * 1024;

const MCP_DISABLED = Deno.env.get("MCP_DISABLED") === "1";
const MCP_TOKEN = Deno.env.get("MCP_TOKEN") ?? "";
const MCP_ALLOWED_ORIGINS = (Deno.env.get("MCP_ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Version: APP_VERSION env wins, else the `version` field in deno.json.
function readPkgVersion(): string {
  try {
    const v = JSON.parse(Deno.readTextFileSync(new URL("../deno.json", import.meta.url))).version;
    return typeof v === "string" && v ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const APP_VERSION = Deno.env.get("APP_VERSION") ?? readPkgVersion();

const watcher = new PortWatcher();
const rfc = new Rfc2217Manager(RFC_HOST);
const mdns = MDNS_DISABLED ? null : new MdnsManager();
mdns?.publishStatic(PORT);

function rfcAssignmentList() {
  return [...rfc.getAssignments()].map(([path, tcpPort]) => ({ path, tcpPort }));
}

function enrich(ports: PortInfo[]): PortInfo[] {
  const tcp = rfc.getAssignments();
  return ports.map((p) => ({ ...p, tcpPort: tcp.get(p.path) }));
}

async function portsWithRfc(): Promise<PortInfo[]> {
  const ports = await listPorts();
  rfc.sync(ports.map((p) => p.path));
  mdns?.syncRfc(rfcAssignmentList());
  return enrich(ports);
}

// Track WS connections so we can fan out port-list updates.
const portListClients = new Set<WebSocket>();
watcher.subscribe((ports) => {
  rfc.sync(ports.map((p) => p.path));
  mdns?.syncRfc(rfcAssignmentList());
  const msg = JSON.stringify({ type: "ports", ports: enrich(ports) });
  for (const ws of portListClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
});

watcher.start();

if (mdns) {
  const shutdown = async () => {
    try {
      await mdns.shutdown();
    } finally {
      Deno.exit(0);
    }
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
};

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return new Response("bad path", { status: 400 });
  const ext = rel.substring(rel.lastIndexOf("."));
  try {
    if (ext === ".html") {
      const name = rel.replace(/^\//, "").replace(/\.html$/, "");
      const html = await eta.renderAsync(name, { isDev: IS_DEV, bsPort: BS_PORT, version: APP_VERSION });
      if (html != null) {
        return new Response(html, { headers: { "content-type": MIME[".html"] } });
      }
    }
    const file = await Deno.open(new URL("." + rel, PUBLIC_DIR), { read: true });
    return new Response(file.readable, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

function handleWs(req: Request): Response {
  const url = new URL(req.url);
  const { socket, response } = Deno.upgradeWebSocket(req);

  if (url.pathname === "/ws/ports") {
    socket.onopen = async () => {
      portListClients.add(socket);
      socket.send(JSON.stringify({ type: "ports", ports: await portsWithRfc() }));
    };
    socket.onclose = () => portListClients.delete(socket);
    socket.onerror = () => portListClients.delete(socket);
    return response;
  }

  if (url.pathname === "/ws/serial") {
    const path = url.searchParams.get("path");
    const baudRate = Number(url.searchParams.get("baud") ?? 115200);
    if (!path) {
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "error", message: "missing path" }));
        socket.close();
      };
      return response;
    }

    let writer: ((data: Uint8Array) => void) | null = null;
    let detach: (() => void) | null = null;
    let logger: LogWriter | null = null;
    const ringChunks: Uint8Array[] = [];
    let ringBytes = 0;
    const pushRing = (chunk: Uint8Array) => {
      ringChunks.push(chunk);
      ringBytes += chunk.byteLength;
      while (ringBytes > LOG_RING_BYTES && ringChunks.length > 1) {
        const dropped = ringChunks.shift()!;
        ringBytes -= dropped.byteLength;
      }
    };
    const closeLogger = async () => {
      if (!logger) return;
      const l = logger;
      logger = null;
      try { await l.close(); } catch { /* ignore */ }
    };
    let resetFn: ((bootloader?: boolean) => Promise<void>) | null = null;
    let flashModeFn: (() => Promise<void>) | null = null;
    let detectFn:
      | (() => Promise<{
          chip: string;
          magic: number;
          mac?: string;
          revision?: string;
          packageName?: string;
          features?: string[];
          crystal?: string;
        }>)
      | null = null;
    // deno-lint-ignore no-explicit-any
    let scanFn: (() => Promise<any>) | null = null;
    const id = crypto.randomUUID();

    socket.binaryType = "arraybuffer";

    socket.onopen = async () => {
      try {
        const handle = await attach(path, baudRate, {
          id,
          onData: (chunk) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
            if (logger) {
              logger.writeBytes(chunk).catch((e) =>
                console.error(`[ws/serial ${path}] log write failed:`, e)
              );
            } else {
              pushRing(chunk);
            }
          },
          onClose: (reason) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "closed", reason }));
              socket.close();
            }
          },
        });
        writer = handle.write;
        detach = handle.detach;
        resetFn = handle.reset;
        flashModeFn = handle.setFlashMode;
        detectFn = handle.detect;
        scanFn = handle.scan;
        socket.send(JSON.stringify({ type: "open", path, baudRate }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        socket.send(JSON.stringify({ type: "error", message: msg }));
        socket.close();
      }
    };

    socket.onmessage = (ev) => {
      if (!writer) return;
      if (ev.data instanceof ArrayBuffer) {
        writer(new Uint8Array(ev.data));
        return;
      }
      if (typeof ev.data !== "string") return;

      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        writer(new TextEncoder().encode(ev.data));
        return;
      }

      try {
        if (msg.type === "write" && typeof msg.data === "string") {
          writer(new TextEncoder().encode(msg.data));
        } else if (msg.type === "log-enable") {
          const logId = typeof msg.id === "string" ? msg.id : "";
          if (!logId) {
            socket.send(JSON.stringify({ type: "log-status", state: "error", message: "missing id" }));
          } else if (logger) {
            socket.send(JSON.stringify({
              type: "log-status", state: "active", path: logger.path, size: logger.size,
            }));
          } else {
            (async () => {
              try {
                const l = new LogWriter(logId, { logDir: LOG_DIR, maxBytes: LOG_MAX_BYTES });
                await l.open();
                for (const c of ringChunks) await l.writeBytes(c);
                ringChunks.length = 0;
                ringBytes = 0;
                logger = l;
                socket.send(JSON.stringify({
                  type: "log-status", state: "active", path: l.path, size: l.size,
                }));
                console.log(`[ws/serial ${path}] logging to ${l.path}`);
              } catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                socket.send(JSON.stringify({ type: "log-status", state: "error", message: m }));
              }
            })();
          }
        } else if (msg.type === "log-disable") {
          closeLogger().then(() => {
            socket.send(JSON.stringify({ type: "log-status", state: "disabled" }));
          });
        } else if (msg.type === "flash-mode") {
          console.log(`[ws/serial ${path}] flash-mode requested`);
          if (!flashModeFn) {
            console.warn(`[ws/serial ${path}] flash-mode: flashModeFn is null`);
            socket.send(JSON.stringify({ type: "error", message: "flash-mode: handle not ready" }));
          } else {
            flashModeFn().then(
              () => {
                console.log(`[ws/serial ${path}] flash-mode complete`);
                socket.send(JSON.stringify({ type: "flash-mode-ack" }));
              },
              (err) => {
                console.error(`[ws/serial ${path}] flash-mode failed:`, err);
                socket.send(JSON.stringify({ type: "error", message: `flash-mode failed: ${err.message ?? err}` }));
              },
            );
          }
        } else if (msg.type === "reset") {
          resetFn?.(!!msg.bootloader).then(
            () => socket.send(JSON.stringify({ type: "reset-ack", bootloader: !!msg.bootloader })),
            (err) => socket.send(JSON.stringify({ type: "error", message: `reset failed: ${err.message ?? err}` })),
          );
        } else if (msg.type === "device-info-request") {
          socket.send(JSON.stringify({
            type: "device-info",
            info: {
              chip: null,
              transport: { path, baud: baudRate },
              status: "Connected. Click Detect to probe the ROM bootloader.",
            },
          }));
        } else if (
          msg.type === "apps-request" ||
          msg.type === "partitions-request" ||
          msg.type === "nvs-read"
        ) {
          if (!scanFn) {
            socket.send(JSON.stringify({
              type: "detect-status", state: "error", message: "scan: handle not ready",
            }));
          } else {
            socket.send(JSON.stringify({ type: "detect-status", state: "scanning" }));
            scanFn().then(
              (scan) => {
                if (socket.readyState !== WebSocket.OPEN) return;
                const flashBytes = parseFlashSizeStr(scan.flashSize);
                socket.send(JSON.stringify({
                  type: "partitions",
                  partitions: scan.partitions,
                  flashSize: flashBytes,
                  flashSizeLabel: scan.flashSize,
                }));
                socket.send(JSON.stringify({ type: "apps", slots: scan.apps }));
                if (scan.nvs) {
                  socket.send(JSON.stringify({ type: "nvs-result", ...nvsToJson(scan.nvs) }));
                } else if (scan.nvsError) {
                  socket.send(JSON.stringify({ type: "nvs-result", error: scan.nvsError }));
                }
                socket.send(JSON.stringify({ type: "detect-status", state: "done" }));
              },
              (err) => {
                console.error(`[ws/serial ${path}] ${msg.type} failed:`, err);
                if (socket.readyState !== WebSocket.OPEN) return;
                socket.send(JSON.stringify({
                  type: "detect-status",
                  state: "error",
                  message: `scan: ${err?.message ?? String(err)}`,
                }));
              },
            );
          }
        } else if (msg.type === "cp210x-set-serial" || msg.type === "cp210x-set-product") {
          const vid = typeof msg.vid === "string" ? msg.vid : "";
          const pid = typeof msg.pid === "string" ? msg.pid : "";
          const currentSerial = typeof msg.currentSerial === "string" ? msg.currentSerial : "-";
          const newValue = typeof msg.newValue === "string"
            ? msg.newValue
            : typeof msg.newSerial === "string" ? msg.newSerial : "";
          const field: "serial" | "product" =
            msg.type === "cp210x-set-product" ? "product" : "serial";
          if (!vid || !pid || !newValue) {
            socket.send(JSON.stringify({
              type: "cp210x-status", state: "error", field,
              message: `missing vid/pid/newValue`,
            }));
          } else {
            socket.send(JSON.stringify({ type: "cp210x-status", state: "releasing-port", field }));
            detach?.();
            closeLogger();
            detach = null; writer = null; resetFn = null; flashModeFn = null; detectFn = null; scanFn = null;
            socket.send(JSON.stringify({ type: "cp210x-status", state: "writing", field }));
            runCp210xWriteSerial(vid, pid, currentSerial, newValue, field).then(
              (result) => {
                if (socket.readyState !== WebSocket.OPEN) return;
                if (result.ok) {
                  socket.send(JSON.stringify({
                    type: "cp210x-status", state: "done",
                    wrote: result.wrote, field: result.field ?? field,
                  }));
                } else {
                  socket.send(JSON.stringify({
                    type: "cp210x-status", state: "error", field,
                    message: result.error, platformHint: result.platformHint,
                  }));
                }
                setTimeout(() => {
                  try { socket.close(); } catch { /* ignore */ }
                }, 100);
              },
            );
          }
        } else if (msg.type === "detect-chip-request") {
          if (!detectFn) {
            socket.send(JSON.stringify({
              type: "detect-status", state: "error", message: "handle not ready",
            }));
          } else {
            socket.send(JSON.stringify({ type: "detect-status", state: "running" }));
            detectFn().then(
              async (result) => {
                if (socket.readyState !== WebSocket.OPEN) return;
                socket.send(JSON.stringify({
                  type: "device-info",
                  info: {
                    chip: result.chip,
                    magic: `0x${result.magic.toString(16).padStart(8, "0")}`,
                    mac: result.mac,
                    revision: result.revision,
                    packageName: result.packageName,
                    features: result.features,
                    crystal: result.crystal,
                    transport: { path, baud: baudRate },
                    status: `Detected via ROM bootloader — EFUSE read OK.`,
                  },
                }));

                // Deep scan: upload stub, read partition table at 0x8000.
                // On failure, report it but keep the chip info we already sent.
                if (!scanFn) {
                  socket.send(JSON.stringify({ type: "detect-status", state: "done" }));
                  return;
                }
                socket.send(JSON.stringify({ type: "detect-status", state: "scanning" }));
                try {
                  const scan = await scanFn();
                  if (socket.readyState !== WebSocket.OPEN) return;
                  const flashBytes = parseFlashSizeStr(scan.flashSize);
                  socket.send(JSON.stringify({
                    type: "partitions",
                    partitions: scan.partitions,
                    flashSize: flashBytes,
                    flashSizeLabel: scan.flashSize,
                  }));
                  socket.send(JSON.stringify({ type: "apps", slots: scan.apps }));
                  if (scan.nvs) {
                    socket.send(JSON.stringify({
                      type: "nvs-result",
                      ...nvsToJson(scan.nvs),
                    }));
                  } else if (scan.nvsError) {
                    socket.send(JSON.stringify({ type: "nvs-result", error: scan.nvsError }));
                  }
                  if (scan.flashSize) {
                    socket.send(JSON.stringify({
                      type: "device-info",
                      info: {
                        flashSize: scan.flashSize,
                        flashSizeBytes: flashBytes,
                        transport: { path, baud: baudRate },
                      },
                    }));
                  }
                  socket.send(JSON.stringify({ type: "detect-status", state: "done" }));
                } catch (err) {
                  console.error(`[ws/serial ${path}] scan failed:`, err);
                  if (socket.readyState !== WebSocket.OPEN) return;
                  socket.send(JSON.stringify({
                    type: "detect-status",
                    state: "error",
                    message: `partition scan: ${err instanceof Error ? err.message : String(err)}`,
                  }));
                }
              },
              (err) => {
                if (socket.readyState !== WebSocket.OPEN) return;
                socket.send(JSON.stringify({
                  type: "detect-status",
                  state: "error",
                  message: err?.message ?? String(err),
                }));
              },
            );
          }
        }
      } catch (err) {
        console.error(`[ws/serial ${path}] handler threw on ${msg.type}:`, err);
        try {
          socket.send(JSON.stringify({
            type: "detect-status",
            state: "error",
            message: `handler threw: ${err instanceof Error ? err.message : String(err)}`,
          }));
        } catch { /* ignore */ }
      }
    };

    socket.onclose = () => { detach?.(); closeLogger(); };
    socket.onerror = () => { detach?.(); closeLogger(); };

    return response;
  }

  socket.close();
  return response;
}

const mcpHandler = MCP_DISABLED ? null : makeMcpHandler({
  portsWithRfc,
  nvsToJson: (nvs) => nvsToJson(nvs as NvsParseResult),
  token: MCP_TOKEN,
  allowedOrigins: MCP_ALLOWED_ORIGINS,
  version: APP_VERSION,
});

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);

  if (req.headers.get("upgrade") === "websocket") {
    return handleWs(req);
  }

  if (url.pathname === "/mcp" && mcpHandler) {
    return mcpHandler(req);
  }

  if (url.pathname === "/api/ports") {
    return Response.json({ ports: await portsWithRfc() });
  }

  if (url.pathname === "/api/sessions") {
    return Response.json({ sessions: activeSessions() });
  }

  return serveStatic(url.pathname);
});

console.log(`ESP32 Workbench listening on http://localhost:${PORT}`);
if (mdns) {
  console.log("mDNS: advertising _http._tcp, _esp32-workbench._tcp, _rfc2217._tcp");
}
