// ESP ROM bootloader chip detection. Protocol reference: esptool docs.
// We only need two commands: SYNC (to enter the command loop) and READ_REG
// (to read the chip-magic register). Frames are SLIP-encoded.

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

const CMD_SYNC = 0x08;
const CMD_READ_REG = 0x0a;

const CHIP_DETECT_MAGIC_REG_ADDR = 0x40001000;

// Known chip magic values at 0x40001000. Kept conservative; unknowns fall
// through to a hex-formatted "unknown" label so the UI still shows data.
const CHIP_MAGIC: Record<number, string> = {
  0x00f01d83: "ESP32",
  0x000007c6: "ESP32-S2",
  0x00000009: "ESP32-S3",
  0x6921506f: "ESP32-C3",
  0x1b31506f: "ESP32-C3 (ECO3)",
  0x4881606f: "ESP32-C3 (ECO6)",
  0x4361606f: "ESP32-C3 (ECO7)",
  0x2ce0806f: "ESP32-C6",
  0xca26cc22: "ESP32-H2",
  0x0da1806f: "ESP32-C2",
  0xfff0c101: "ESP8266",
};

export function encodeSlip(payload: Uint8Array): Uint8Array {
  const out: number[] = [SLIP_END];
  for (const b of payload) {
    if (b === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
    else if (b === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
    else out.push(b);
  }
  out.push(SLIP_END);
  return new Uint8Array(out);
}

export class SlipDecoder {
  private buf: number[] = [];
  private inFrame = false;
  private escaped = false;

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const b of chunk) {
      if (!this.inFrame) {
        if (b === SLIP_END) {
          this.inFrame = true;
          this.buf = [];
        }
        continue;
      }
      if (this.escaped) {
        if (b === SLIP_ESC_END) this.buf.push(SLIP_END);
        else if (b === SLIP_ESC_ESC) this.buf.push(SLIP_ESC);
        else this.buf.push(b);
        this.escaped = false;
        continue;
      }
      if (b === SLIP_ESC) {
        this.escaped = true;
        continue;
      }
      if (b === SLIP_END) {
        if (this.buf.length > 0) frames.push(new Uint8Array(this.buf));
        this.inFrame = false;
        this.buf = [];
        continue;
      }
      this.buf.push(b);
    }
    return frames;
  }
}

function buildCommand(cmd: number, data: Uint8Array, checksum = 0): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  out[0] = 0x00; // request direction
  out[1] = cmd;
  out[2] = data.length & 0xff;
  out[3] = (data.length >> 8) & 0xff;
  out[4] = checksum & 0xff;
  out[5] = (checksum >> 8) & 0xff;
  out[6] = (checksum >> 16) & 0xff;
  out[7] = (checksum >> 24) & 0xff;
  out.set(data, 8);
  return encodeSlip(out);
}

export function buildSync(): Uint8Array {
  const payload = new Uint8Array(36);
  payload[0] = 0x07;
  payload[1] = 0x07;
  payload[2] = 0x12;
  payload[3] = 0x20;
  for (let i = 4; i < 36; i++) payload[i] = 0x55;
  return buildCommand(CMD_SYNC, payload);
}

export function buildReadReg(addr: number): Uint8Array {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, addr >>> 0, true);
  return buildCommand(CMD_READ_REG, data);
}

export interface BootloaderResponse {
  ok: boolean;
  cmd: number;
  value: number;
  data: Uint8Array;
}

export function parseResponse(frame: Uint8Array): BootloaderResponse | null {
  if (frame.length < 8) return null;
  if (frame[0] !== 0x01) return null;
  const cmd = frame[1];
  const size = frame[2] | (frame[3] << 8);
  const value =
    (frame[4] | (frame[5] << 8) | (frame[6] << 16) | (frame[7] << 24)) >>> 0;
  const data = frame.slice(8, 8 + size);
  const ok = data.length >= 2 && data[data.length - 2] === 0x00;
  return { ok, cmd, value, data };
}

export function chipFromMagic(magic: number): string {
  return CHIP_MAGIC[magic] ?? `unknown (0x${magic.toString(16).padStart(8, "0")})`;
}

export interface DetectIo {
  write: (bytes: Uint8Array) => void;
  reset: (bootloader: boolean) => Promise<void>;
  addProbe: (onChunk: (chunk: Uint8Array) => void) => () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DetectResult {
  chip: string;
  magic: number;
  mac?: string;
  revision?: string;
  packageName?: string;
  features?: string[];
  crystal?: string;
}

// ESP32 EFUSE_BLK0 register addresses (pre-V3 register file).
const ESP32_EFUSE_RDATA1 = 0x3ff5a004;
const ESP32_EFUSE_RDATA2 = 0x3ff5a008;
const ESP32_EFUSE_RDATA3 = 0x3ff5a00c;
const ESP32_EFUSE_RDATA5 = 0x3ff5a014;
const ESP32_APB_CTRL_DATE = 0x3ff6607c; // bit 31 is the third revision bit

export async function detectChip(io: DetectIo): Promise<DetectResult> {
  const decoder = new SlipDecoder();
  const responses: BootloaderResponse[] = [];
  const removeProbe = io.addProbe((chunk) => {
    for (const f of decoder.push(chunk)) {
      const r = parseResponse(f);
      if (r) responses.push(r);
    }
  });

  async function readReg(addr: number): Promise<number> {
    responses.length = 0;
    io.write(buildReadReg(addr));
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const r = responses.find((x) => x.cmd === CMD_READ_REG);
      if (r) {
        if (!r.ok) throw new Error(`READ_REG 0x${addr.toString(16)} failed`);
        return r.value;
      }
      await sleep(10);
    }
    throw new Error(`READ_REG 0x${addr.toString(16)} timeout`);
  }

  try {
    await io.reset(true);
    await sleep(150);
    responses.length = 0;

    let synced = false;
    const syncFrame = buildSync();
    for (let attempt = 0; attempt < 7 && !synced; attempt++) {
      io.write(syncFrame);
      const deadline = Date.now() + 120;
      while (Date.now() < deadline) {
        if (responses.some((r) => r.cmd === CMD_SYNC && r.ok)) {
          synced = true;
          break;
        }
        await sleep(10);
      }
    }
    if (!synced) throw new Error("bootloader SYNC timeout — is the device in download mode?");
    await sleep(100);

    const magic = await readReg(CHIP_DETECT_MAGIC_REG_ADDR);
    const chip = chipFromMagic(magic);
    const result: DetectResult = { chip, magic };

    if (chip === "ESP32") {
      await enrichEsp32(readReg, result);
    }
    // TODO: S2/S3/C3/C6/H2 have different EFUSE register maps; add dispatch when needed.

    return result;
  } finally {
    removeProbe();
    try { await io.reset(false); } catch { /* ignore */ }
  }
}

async function enrichEsp32(
  readReg: (addr: number) => Promise<number>,
  result: DetectResult,
): Promise<void> {
  const rdata1 = await readReg(ESP32_EFUSE_RDATA1);
  const rdata2 = await readReg(ESP32_EFUSE_RDATA2);
  const rdata3 = await readReg(ESP32_EFUSE_RDATA3);
  const rdata5 = await readReg(ESP32_EFUSE_RDATA5);
  let apbDate = 0;
  try { apbDate = await readReg(ESP32_APB_CTRL_DATE); } catch { /* older chips */ }

  result.mac = formatMacEsp32(rdata1, rdata2);
  result.revision = esp32Revision(rdata3, rdata5, apbDate);
  result.packageName = esp32Package(rdata3, rdata5);
  result.features = esp32Features(rdata3, rdata5, result.packageName);
  result.crystal = "40 MHz"; // ESP32 is 40 MHz on ~every board; 26 MHz is rare.
}

function formatMacEsp32(rdata1: number, rdata2: number): string {
  // Pack rdata2 (MSBs) and rdata1 (LSBs) as big-endian 8 bytes, then skip first 2.
  // Equivalent to esptool: pack(">II", mac1, mac0)[2:]
  const mac = [
    (rdata2 >>> 8) & 0xff,
    rdata2 & 0xff,
    (rdata1 >>> 24) & 0xff,
    (rdata1 >>> 16) & 0xff,
    (rdata1 >>> 8) & 0xff,
    rdata1 & 0xff,
  ];
  return mac.map((b) => b.toString(16).padStart(2, "0")).join(":").toUpperCase();
}

function esp32Revision(rdata3: number, rdata5: number, apbDate: number): string {
  const bit0 = (rdata3 >>> 15) & 1;
  const bit1 = (rdata5 >>> 20) & 1;
  const bit2 = (apbDate >>> 31) & 1;
  const combined = (bit2 << 2) | (bit1 << 1) | bit0;
  const major = ({ 0: 0, 1: 1, 3: 2, 7: 3 } as Record<number, number>)[combined] ?? 0;
  return `v${major}.0`;
}

function esp32Package(rdata3: number, rdata5: number): string {
  const pkg = (((rdata5 >>> 2) & 0x1) << 3) | ((rdata3 >>> 9) & 0x7);
  return ({
    0: "ESP32-D0WDQ6",
    1: "ESP32-D0WD",
    2: "ESP32-D2WDQ5",
    4: "ESP32-U4WDH",
    5: "ESP32-PICO-D4",
    6: "ESP32-PICO-V3-02",
    7: "ESP32-PICO-V3",
  } as Record<number, string>)[pkg] ?? `unknown (pkg=${pkg})`;
}

function esp32Features(rdata3: number, rdata5: number, pkg: string): string[] {
  const features: string[] = ["WiFi"];
  const chipDisableBt = ((rdata3 >>> 1) & 1) === 1;
  if (!chipDisableBt) features.push("BT");
  const chipDisableAppCpu = ((rdata3 >>> 0) & 1) === 1;
  features.push(chipDisableAppCpu ? "Single Core" : "Dual Core");
  const embeddedFlash = pkg.startsWith("ESP32-PICO") || pkg.startsWith("ESP32-U4WDH") || pkg === "ESP32-D2WDQ5";
  if (embeddedFlash) features.push("Embedded Flash");
  if (pkg.includes("PICO-V3-02")) features.push("Embedded PSRAM");
  // VRef calibration bit (RDATA5 bit 5) indicates ADC calibration efuse is blown.
  if (((rdata5 >>> 5) & 1) === 1) features.push("VRef cal in efuse");
  return features;
}
