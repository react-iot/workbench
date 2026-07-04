import { openSerial, type SerialBackend } from "./serial/index.ts";

export interface ResetOptions {
  resetHoldMs?: number;
  gpio0HoldMs?: number;
  ignSetControl?: boolean;
  verbose?: boolean;
  logger?: (msg: string) => void;
}

const DEFAULT_RESET_HOLD_MS = 120;
const DEFAULT_GPIO0_HOLD_MS = 80;

// SLIP sync packet — the ROM bootloader echoes it back on successful entry.
const SLIP_SYNC = (() => {
  const body = new Uint8Array([
    0xc0, 0x00, 0x08, 0x24, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x07, 0x07, 0x12, 0x20,
    ...new Array(32).fill(0x55),
    0xc0,
  ]);
  return body;
})();

/**
 * Put the chip into ROM download mode.
 * GPIO0 is asserted LOW at the moment EN rises from reset.
 */
export async function enterBootloader(
  port: string,
  opts?: ResetOptions,
): Promise<void> {
  const { resetHoldMs, gpio0HoldMs, log } = resolveOptions(opts);
  const serial = openSerial(normalizePort(port, opts?.ignSetControl ?? true), 115200);
  try {
    log(`open ${port}`);
    await serial.open();
    const t0 = performance.now();

    log(`t=0  setDtrRts(false, true)  — EN LOW`);
    await serial.setDtrRts(false, true);

    await sleep(resetHoldMs);
    log(`t=${elapsed(t0)}ms  setDtrRts(true, false)  — EN HIGH, GPIO0 LOW`);
    await serial.setDtrRts(true, false);

    await sleep(gpio0HoldMs);
    log(`t=${elapsed(t0)}ms  setDtrRts(false, false)  — release`);
    await serial.setDtrRts(false, false);

    log(`done — chip should be in ROM bootloader`);
  } finally {
    await serial.close();
  }
}

/**
 * Release reset with GPIO0 high → normal boot from flash.
 */
export async function hardReset(
  port: string,
  opts?: ResetOptions,
): Promise<void> {
  const { resetHoldMs, log } = resolveOptions(opts);
  const serial = openSerial(normalizePort(port, opts?.ignSetControl ?? true), 115200);
  try {
    log(`open ${port}`);
    await serial.open();
    const t0 = performance.now();

    log(`t=0  setDtrRts(false, true)  — EN LOW`);
    await serial.setDtrRts(false, true);

    await sleep(resetHoldMs);
    log(`t=${elapsed(t0)}ms  setDtrRts(false, false)  — EN HIGH, GPIO0 HIGH`);
    await serial.setDtrRts(false, false);

    log(`done — chip booting from flash`);
  } finally {
    await serial.close();
  }
}

/**
 * Send a SLIP sync packet and return true iff the ROM bootloader responds
 * within 500 ms. Call after enterBootloader().
 */
export async function verify(
  port: string,
  opts?: ResetOptions,
): Promise<boolean> {
  const { log } = resolveOptions(opts);
  const serial = openSerial(normalizePort(port, opts?.ignSetControl ?? true), 115200);
  try {
    await serial.open();
    await serial.flushInput();
    log(`sending SLIP sync`);
    await serial.write(SLIP_SYNC);

    // Read until we see two 0xC0 bytes (SLIP frame delimiters) — any non-empty
    // response that is a valid SLIP frame means the bootloader is alive.
    const deadline = performance.now() + 500;
    let buf = new Uint8Array(0);
    while (performance.now() < deadline) {
      const chunk = await serial.read(64, Math.max(1, deadline - performance.now()));
      if (chunk.length > 0) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        buf = merged;
        let c0count = 0;
        for (const b of buf) if (b === 0xc0) c0count++;
        if (c0count >= 2) {
          log(`verify OK — saw ${c0count} SLIP delimiters`);
          return true;
        }
      }
    }
    log(`verify FAILED — no SLIP response within 500 ms`);
    return false;
  } finally {
    await serial.close();
  }
}

// ---- internal helpers ----

interface Resolved {
  resetHoldMs: number;
  gpio0HoldMs: number;
  log: (msg: string) => void;
}

function resolveOptions(opts?: ResetOptions): Resolved {
  const envReset = Deno.env.get("FLASH_HELPER_RESET_HOLD_MS");
  const envGpio0 = Deno.env.get("FLASH_HELPER_GPIO0_HOLD_MS");
  const resetHoldMs =
    opts?.resetHoldMs ??
    (envReset ? parseInt(envReset, 10) : DEFAULT_RESET_HOLD_MS);
  const gpio0HoldMs =
    opts?.gpio0HoldMs ??
    (envGpio0 ? parseInt(envGpio0, 10) : DEFAULT_GPIO0_HOLD_MS);
  const verbose = opts?.verbose ?? false;
  const userLogger = opts?.logger;
  const log = verbose
    ? (msg: string) => (userLogger ? userLogger(msg) : console.debug(msg))
    : (_msg: string) => {};
  return { resetHoldMs, gpio0HoldMs, log };
}

function normalizePort(port: string, addIgn: boolean): string {
  if (!port.startsWith("rfc2217://") || !addIgn) return port;
  if (port.includes("ign_set_control")) return port;
  return port + (port.includes("?") ? "&" : "?") + "ign_set_control";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function elapsed(t0: number): number {
  return Math.round(performance.now() - t0);
}
