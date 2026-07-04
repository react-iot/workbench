import { Transport, ESPLoader } from "./esptool/index.js";
import type { Handle } from "./serial.ts";
import { parsePartitionTable, type PartitionEntry } from "./partition-parse.ts";
import {
  activeOtaSlot,
  parseAppDesc,
  parseOtaData,
  type AppDesc,
  type OtaSelectEntry,
} from "./app-slot-parse.ts";
import { parseNvs, type NvsParseResult } from "./nvs-parse.ts";

interface SerialLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  open: (opts: { baudRate?: number }) => Promise<void>;
  close: () => Promise<void>;
  setSignals: (opts: { dataTerminalReady?: boolean; requestToSend?: boolean }) => Promise<void>;
  getInfo: () => { usbVendorId?: number; usbProductId?: number };
}

class FakeSerialPort implements SerialLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  #handle: Handle;
  #removeProbe: (() => void) | null = null;
  #streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  #usbIds: { usbVendorId?: number; usbProductId?: number };

  constructor(handle: Handle, usbIds: { usbVendorId?: number; usbProductId?: number } = {}) {
    this.#handle = handle;
    this.#usbIds = usbIds;

    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#streamController = controller;
        this.#removeProbe = handle.addProbe((chunk) => {
          try {
            controller.enqueue(new Uint8Array(chunk));
          } catch {
            // controller may be closed during shutdown
          }
        });
      },
      cancel: () => {
        this.#removeProbe?.();
        this.#removeProbe = null;
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        handle.write(chunk);
        return Promise.resolve();
      },
    });
  }

  open(opts: { baudRate?: number }): Promise<void> {
    if (opts?.baudRate && this.#handle.getBaud() !== opts.baudRate) {
      return this.#handle.setBaud(opts.baudRate);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#removeProbe?.();
    this.#removeProbe = null;
    try {
      this.#streamController?.close();
    } catch { /* already closed */ }
    return Promise.resolve();
  }

  async setSignals(opts: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    if (opts.dataTerminalReady !== undefined) {
      await this.#handle.setDtr(opts.dataTerminalReady);
    }
    if (opts.requestToSend !== undefined) {
      await this.#handle.setRts(opts.requestToSend);
    }
  }

  getInfo() {
    return this.#usbIds;
  }
}

export interface AppSlot {
  name: string;
  offset: number;
  size: number;
  desc?: AppDesc;        // present when the slot contains a valid app image
  active: boolean;
  valid: boolean;        // has the image magic byte
  otaState?: string;     // from ota_data (for ota_N slots only)
  otaSeq?: number;
}

export interface DeepScanResult {
  chip: string;
  partitions: PartitionEntry[];
  partitionBytes: Uint8Array;
  apps: AppSlot[];
  nvs?: NvsParseResult;
  nvsError?: string;
  flashSize?: string;
}

// Drive esptool-js through our Handle: sync → stub upload → read flash at
// 0x8000 (the canonical ESP-IDF partition table offset). Returns the raw
// 4 KiB blob for the caller to parse.
export async function deepScanChip(
  handle: Handle,
  usbIds: { usbVendorId?: number; usbProductId?: number } = {},
): Promise<DeepScanResult> {
  handle.setDetecting(true);
  const fake = new FakeSerialPort(handle, usbIds);
  // deno-lint-ignore no-explicit-any
  const transport = new Transport(fake as any, false, true);

  const terminal = {
    clean: () => {},
    writeLine: (_line: string) => {},
    write: (_s: string) => {},
  };

  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    terminal,
    enableTracing: false,
    debugLogging: false,
  });

  try {
    // Use our own reset sequence to enter the ROM bootloader — esptool-js's
    // ClassicReset doesn't reliably strap IO0 on this CP210x under the
    // extra latency our worker introduces. Then tell the loader to skip its
    // own reset with "no_reset".
    await handle.reset(true);
    await new Promise((r) => setTimeout(r, 150));

    const chip = await loader.main("no_reset");
    const partitionBytes = await readFlashBytes(loader, 0x8000, 0x1000);
    const partitions = parsePartitionTable(partitionBytes);

    const apps = await readAppSlots(loader, partitions);

    let nvs: NvsParseResult | undefined;
    let nvsError: string | undefined;
    const nvsPart = partitions.find((p) => p.type === "data" && p.subtype === "nvs");
    if (nvsPart) {
      try {
        const nvsBytes = await readFlashBytes(loader, nvsPart.offset, nvsPart.size);
        nvs = parseNvs(nvsBytes);
      } catch (err) {
        nvsError = err instanceof Error ? err.message : String(err);
      }
    }

    let flashSize: string | undefined;
    try {
      // deno-lint-ignore no-explicit-any
      flashSize = await (loader as any).detectFlashSize();
    } catch { /* ignore */ }

    return { chip, partitions, partitionBytes, apps, nvs, nvsError, flashSize };
  } finally {
    // esptool-js's hardReset is unreliable through our FakeSerialPort (same
    // DTR/RTS timing problem as ClassicReset on some CP210x adapters), so
    // disconnect the loader first, then drive our own proven reset(false)
    // sequence via the worker to guarantee the chip reboots into user code.
    try { await transport.disconnect(); } catch { /* ignore */ }
    handle.setDetecting(false);
    try {
      await handle.reset(false);
    } catch { /* ignore — best-effort post-discover reboot */ }
  }
}

// esptool-js's readFlash returns a Uint8Array in some versions and a string
// of raw bytes in others. Normalize to Uint8Array.
async function readFlashBytes(
  // deno-lint-ignore no-explicit-any
  loader: any,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const result = await loader.readFlash(offset, length);
  if (result instanceof Uint8Array) return result;
  if (typeof result === "string") {
    const out = new Uint8Array(result.length);
    for (let i = 0; i < result.length; i++) out[i] = result.charCodeAt(i) & 0xff;
    return out;
  }
  // ArrayBuffer fallback
  return new Uint8Array(result);
}

// deno-lint-ignore no-explicit-any
async function readAppSlots(loader: any, partitions: PartitionEntry[]): Promise<AppSlot[]> {
  const appParts = partitions.filter((p) => p.type === "app");
  const otaParts = appParts
    .filter((p) => /^ota_\d+$/.test(p.subtype))
    .sort((a, b) => parseInt(a.subtype.slice(4), 10) - parseInt(b.subtype.slice(4), 10));

  // Read OTA data partition if present, to determine the active slot.
  const otaData = partitions.find((p) => p.type === "data" && p.subtype === "ota");
  let s0: OtaSelectEntry | null = null;
  let s1: OtaSelectEntry | null = null;
  if (otaData) {
    try {
      const raw = await readFlashBytes(loader, otaData.offset, Math.min(otaData.size, 0x2000));
      const parsed = parseOtaData(raw);
      s0 = parsed.slot0;
      s1 = parsed.slot1;
    } catch { /* ignore — leave slots without activity markers */ }
  }
  const activeIdx = s0 && s1 ? activeOtaSlot(s0, s1, otaParts.length) : -1;

  const slots: AppSlot[] = [];
  for (const p of appParts) {
    let desc: AppDesc | undefined;
    let valid = false;
    try {
      const head = await readFlashBytes(loader, p.offset, 0x20 + 256);
      valid = head[0] === 0xe9;
      const parsed = parseAppDesc(head);
      if (parsed) desc = parsed;
    } catch { /* slot unreadable → leave desc undefined */ }

    let active = false;
    let otaState: string | undefined;
    let otaSeq: number | undefined;
    const otaMatch = /^ota_(\d+)$/.exec(p.subtype);
    if (otaMatch) {
      const idx = parseInt(otaMatch[1], 10);
      active = idx === activeIdx;
      // Pick the record whose seq matches this slot, if any.
      const fromRec = (rec: OtaSelectEntry | null) =>
        rec && rec.valid && ((rec.seq - 1) % otaParts.length) === idx;
      if (fromRec(s0)) { otaState = s0!.stateLabel; otaSeq = s0!.seq; }
      else if (fromRec(s1)) { otaState = s1!.stateLabel; otaSeq = s1!.seq; }
    } else if (p.subtype === "factory" && activeIdx < 0) {
      active = true; // factory runs when no OTA has happened yet
    }

    slots.push({
      name: p.name,
      offset: p.offset,
      size: p.size,
      desc,
      active,
      valid,
      otaState,
      otaSeq,
    });
  }
  return slots;
}
