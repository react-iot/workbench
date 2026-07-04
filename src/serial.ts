// Broker between WS/RFC2217 subscribers and Node worker subprocesses.
// One worker per serial path. Binary framed stdio protocol matches
// bin/serial-worker.js.

import { detectChip, type DetectResult } from "./esp-detect.ts";
import { deepScanChip, type AppSlot } from "./esptool-bridge.ts";
import type { PartitionEntry } from "./partition-parse.ts";
import type { NvsParseResult } from "./nvs-parse.ts";

const WORKER_SCRIPT = new URL("../bin/serial-worker.js", import.meta.url).pathname;

const TYPE_DATA = 0x01;
const TYPE_SETBAUD = 0x02;
const TYPE_BAUD_ACK = 0x03;
const TYPE_ERROR = 0x04;
const TYPE_OPENED = 0x05;
const TYPE_CLOSED = 0x06;
const TYPE_RESET = 0x07;
const TYPE_RESET_ACK = 0x08;
const TYPE_SETDTR = 0x09;
const TYPE_SETRTS = 0x0a;
const TYPE_LINES_ACK = 0x0b;
const TYPE_FLASHMODE = 0x0c;

export type Subscriber = {
  id: string;
  onData: (chunk: Uint8Array) => void;
  onBaud?: (baud: number) => void;
  onClose: (reason: string) => void;
};

export interface Handle {
  detach: () => void;
  write: (data: Uint8Array) => void;
  setBaud: (baud: number) => Promise<void>;
  getBaud: () => number;
  reset: (bootloader?: boolean) => Promise<void>;
  setDtr: (asserted: boolean) => Promise<void>;
  setRts: (asserted: boolean) => Promise<void>;
  setFlashMode: () => Promise<void>;
  detect: () => Promise<DetectResult>;
  scan: () => Promise<ScanResult>;
  addProbe: (onChunk: (chunk: Uint8Array) => void) => () => void;
  setDetecting: (on: boolean) => void;
}

export interface ScanResult {
  chip: string;
  flashSize?: string;
  partitions: PartitionEntry[];
  apps: AppSlot[];
  nvs?: NvsParseResult;
  nvsError?: string;
}

type Probe = (chunk: Uint8Array) => void;

interface Session {
  path: string;
  baudRate: number;
  subscribers: Map<string, Subscriber>;
  probes: Set<Probe>;
  proc: Deno.ChildProcess;
  stdin: WritableStreamDefaultWriter<Uint8Array>;
  openReady: Promise<void>;
  closed: boolean;
  pendingBaud: Array<(err: Error | null) => void>;
  pendingReset: Array<(err: Error | null) => void>;
  pendingLines: Array<(err: Error | null) => void>;
  detecting: boolean;
}

const sessions = new Map<string, Session>();

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = type;
  out[1] = (payload.length >> 16) & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}

function encodeBaud(baud: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (baud >>> 24) & 0xff;
  b[1] = (baud >>> 16) & 0xff;
  b[2] = (baud >>> 8) & 0xff;
  b[3] = baud & 0xff;
  return b;
}

function decodeBaud(b: Uint8Array): number {
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

async function spawnWorker(path: string, baud: number): Promise<Session> {
  const cmd = new Deno.Command("node", {
    args: [WORKER_SCRIPT, path, String(baud)],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  });
  const proc = cmd.spawn();
  const stdin = proc.stdin.getWriter();

  let resolveOpen!: () => void;
  let rejectOpen!: (err: Error) => void;
  const openReady = new Promise<void>((res, rej) => {
    resolveOpen = res;
    rejectOpen = rej;
  });

  const session: Session = {
    path,
    baudRate: baud,
    subscribers: new Map(),
    probes: new Set(),
    proc,
    stdin,
    openReady,
    closed: false,
    pendingBaud: [],
    pendingReset: [],
    pendingLines: [],
    detecting: false,
  };

  (async () => {
    let buf = new Uint8Array(0);
    try {
      for await (const chunk of proc.stdout) {
        if (buf.length === 0) buf = chunk;
        else {
          const merged = new Uint8Array(buf.length + chunk.length);
          merged.set(buf);
          merged.set(chunk, buf.length);
          buf = merged;
        }
        while (buf.length >= 4) {
          const type = buf[0];
          const len = (buf[1] << 16) | (buf[2] << 8) | buf[3];
          if (buf.length < 4 + len) break;
          const payload = buf.slice(4, 4 + len);
          buf = buf.slice(4 + len);
          dispatch(session, type, payload, resolveOpen, rejectOpen);
        }
      }
    } catch (err) {
      console.error(`serial worker stdout read error (${path}):`, err);
    }
    // stdout closed → process is going away
    finalizeClosed(session, "worker exited");
  })();

  proc.status.then((status) => {
    if (!status.success) {
      rejectOpen(new Error(`serial worker exited with code ${status.code}`));
    }
    finalizeClosed(session, `exit ${status.code}`);
  });

  return session;
}

function dispatch(
  session: Session,
  type: number,
  payload: Uint8Array,
  resolveOpen: () => void,
  rejectOpen: (err: Error) => void,
) {
  switch (type) {
    case TYPE_DATA:
      for (const probe of session.probes) {
        try { probe(payload); } catch (err) { console.error("probe:", err); }
      }
      if (!session.detecting) {
        for (const s of session.subscribers.values()) {
          try { s.onData(payload); } catch (err) { console.error("onData:", err); }
        }
      }
      break;
    case TYPE_BAUD_ACK: {
      const baud = decodeBaud(payload);
      session.baudRate = baud;
      const waiters = session.pendingBaud.splice(0);
      for (const w of waiters) w(null);
      for (const s of session.subscribers.values()) {
        try { s.onBaud?.(baud); } catch (err) { console.error("onBaud:", err); }
      }
      break;
    }
    case TYPE_OPENED:
      resolveOpen();
      break;
    case TYPE_ERROR: {
      const msg = new TextDecoder().decode(payload);
      rejectOpen(new Error(msg));
      for (const s of session.subscribers.values()) {
        try { s.onClose(`error: ${msg}`); } catch (err) { console.error("onClose:", err); }
      }
      break;
    }
    case TYPE_RESET_ACK: {
      const waiters = session.pendingReset.splice(0);
      for (const w of waiters) w(null);
      break;
    }
    case TYPE_LINES_ACK: {
      const waiters = session.pendingLines.splice(0);
      for (const w of waiters) w(null);
      break;
    }
    case TYPE_CLOSED: {
      const reason = new TextDecoder().decode(payload) || "closed";
      finalizeClosed(session, reason);
      break;
    }
  }
}

function finalizeClosed(session: Session, reason: string) {
  if (session.closed) return;
  session.closed = true;
  const err = new Error(reason);
  for (const w of session.pendingBaud.splice(0)) w(err);
  for (const w of session.pendingReset.splice(0)) w(err);
  for (const w of session.pendingLines.splice(0)) w(err);
  for (const s of session.subscribers.values()) {
    try { s.onClose(reason); } catch (err) { console.error("onClose:", err); }
  }
  session.subscribers.clear();
  sessions.delete(session.path);
  try { session.stdin.close(); } catch { /* ignore */ }
}

export async function attach(
  path: string,
  preferredBaud: number,
  sub: Subscriber,
): Promise<Handle> {
  let session = sessions.get(path);

  if (!session) {
    session = await spawnWorker(path, preferredBaud);
    sessions.set(path, session);
    try {
      await session.openReady;
    } catch (err) {
      sessions.delete(path);
      throw err;
    }
  } else {
    await session.openReady;
    if (session.baudRate !== preferredBaud) {
      await setBaudInternal(session, preferredBaud);
    }
  }

  session.subscribers.set(sub.id, sub);
  const owned = session;

  const handle: Handle = {
    detach: () => {
      owned.subscribers.delete(sub.id);
      if (owned.subscribers.size === 0) {
        closeSession(owned).catch(() => {});
      }
    },
    write: (data: Uint8Array) => {
      if (owned.closed) return;
      owned.stdin.write(frame(TYPE_DATA, data)).catch(() => {});
    },
    setBaud: (baud: number) => setBaudInternal(owned, baud),
    getBaud: () => owned.baudRate,
    reset: (bootloader = false) => resetInternal(owned, bootloader),
    setDtr: (asserted: boolean) => setLineInternal(owned, TYPE_SETDTR, asserted),
    setRts: (asserted: boolean) => setLineInternal(owned, TYPE_SETRTS, asserted),
    setFlashMode: () => flashModeInternal(owned),
    detect: () => detectInternal(owned),
    scan: () => scanInternal(owned, () => handle),
    addProbe: (onChunk) => {
      owned.probes.add(onChunk);
      return () => owned.probes.delete(onChunk);
    },
    setDetecting: (on) => { owned.detecting = on; },
  };
  return handle;
}

function scanInternal(session: Session, getHandle: () => Handle): Promise<ScanResult> {
  if (session.closed) return Promise.reject(new Error("session closed"));
  if (session.detecting) return Promise.reject(new Error("a scan or detect is already running"));
  return deepScanChip(getHandle()).then((r) => ({
    chip: r.chip,
    flashSize: r.flashSize,
    partitions: r.partitions,
    apps: r.apps,
    nvs: r.nvs,
    nvsError: r.nvsError,
  }));
}

function setLineInternal(session: Session, frameType: number, asserted: boolean): Promise<void> {
  if (session.closed) return Promise.reject(new Error("session closed"));
  return new Promise<void>((resolve, reject) => {
    session.pendingLines.push((err) => (err ? reject(err) : resolve()));
    const payload = new Uint8Array([asserted ? 1 : 0]);
    session.stdin.write(frame(frameType, payload)).catch(reject);
  });
}

function detectInternal(session: Session): Promise<DetectResult> {
  if (session.closed) return Promise.reject(new Error("session closed"));
  if (session.detecting) return Promise.reject(new Error("detect already running"));
  session.detecting = true;
  return detectChip({
    write: (bytes) => {
      if (session.closed) return;
      session.stdin.write(frame(TYPE_DATA, bytes)).catch(() => {});
    },
    reset: (bootloader) => resetInternal(session, bootloader),
    addProbe: (onChunk) => {
      session.probes.add(onChunk);
      return () => session.probes.delete(onChunk);
    },
  }).finally(() => {
    session.detecting = false;
  });
}

function resetInternal(session: Session, bootloader: boolean): Promise<void> {
  if (session.closed) return Promise.reject(new Error("session closed"));
  return new Promise<void>((resolve, reject) => {
    session.pendingReset.push((err) => (err ? reject(err) : resolve()));
    const payload = new Uint8Array([bootloader ? 1 : 0]);
    session.stdin.write(frame(TYPE_RESET, payload)).catch(reject);
  });
}

function flashModeInternal(session: Session): Promise<void> {
  if (session.closed) return Promise.reject(new Error("session closed"));
  console.log(`[serial ${session.path}] sending TYPE_FLASHMODE to worker`);
  return new Promise<void>((resolve, reject) => {
    // Worker sends TYPE_RESET_ACK (payload[0]=2) when flash-mode sequence completes.
    session.pendingReset.push((err) => (err ? reject(err) : resolve()));
    session.stdin.write(frame(TYPE_FLASHMODE, new Uint8Array(0))).catch(reject);
  });
}

function setBaudInternal(session: Session, baud: number): Promise<void> {
  if (session.baudRate === baud) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    session.pendingBaud.push((err) => (err ? reject(err) : resolve()));
    session.stdin.write(frame(TYPE_SETBAUD, encodeBaud(baud))).catch(reject);
  });
}

async function closeSession(session: Session): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  sessions.delete(session.path);
  try { await session.stdin.close(); } catch { /* ignore */ }

  // Give the worker a moment to exit cleanly, then force-kill.
  const killTimer = setTimeout(() => {
    try { session.proc.kill("SIGKILL"); } catch { /* ignore */ }
  }, 750);
  try {
    await session.proc.status;
  } finally {
    clearTimeout(killTimer);
  }
}

export function activeSessions(): Array<{ path: string; baudRate: number; subscribers: number }> {
  return Array.from(sessions.values()).map((s) => ({
    path: s.path,
    baudRate: s.baudRate,
    subscribers: s.subscribers.size,
  }));
}
