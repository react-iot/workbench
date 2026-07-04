// Parse ESP-IDF OTA bookkeeping and app descriptor blobs.
//
// Per-slot image layout:
//   offset 0x00 : esp_image_header_t              (24 bytes, must start with 0xE9)
//   offset 0x18 : first esp_image_segment_header_t (8 bytes)
//   offset 0x20 : esp_app_desc_t                  (256 bytes, magic 0xABCD5432)
//
// OTA data partition holds two ota_select_entry_t records, each at the start
// of its own 4 KiB sector:
//   struct ota_select_entry_t {
//     uint32_t ota_seq;      // monotonically increasing; 0xFFFFFFFF = empty
//     uint8_t  seq_label[20];
//     uint32_t ota_state;
//     uint32_t crc;
//   };  // 32 bytes total

export interface AppDesc {
  version: string;
  projectName: string;
  time: string;
  date: string;
  idfVersion: string;
  secureVersion: number;
  appElfSha256: string;
}

const APP_IMAGE_MAGIC = 0xe9;
const APP_DESC_MAGIC = 0xabcd5432 >>> 0;

export function parseAppDesc(raw: Uint8Array): AppDesc | null {
  if (raw.length < 0x20 + 256) return null;
  if (raw[0] !== APP_IMAGE_MAGIC) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const descMagic = dv.getUint32(0x20, true);
  if (descMagic !== APP_DESC_MAGIC) return null;

  const secureVersion = dv.getUint32(0x24, true);
  const version = readCString(raw, 0x30, 32);
  const projectName = readCString(raw, 0x50, 32);
  const time = readCString(raw, 0x70, 16);
  const date = readCString(raw, 0x80, 16);
  const idfVersion = readCString(raw, 0x90, 32);
  const sha256Bytes = raw.slice(0xb0, 0xb0 + 32);
  const appElfSha256 = Array.from(sha256Bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return { version, projectName, time, date, idfVersion, secureVersion, appElfSha256 };
}

function readCString(buf: Uint8Array, offset: number, maxLen: number): string {
  const slice = buf.slice(offset, offset + maxLen);
  const nul = slice.indexOf(0);
  const bytes = nul >= 0 ? slice.slice(0, nul) : slice;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export interface OtaSelectEntry {
  seq: number;       // ota_seq; 0xFFFFFFFF means empty/unprogrammed
  state: number;     // ota_state
  stateLabel: string;
  valid: boolean;    // rough "seq != 0xFFFFFFFF"
}

// Parse the two 32-byte ota_select records from an OTA data partition blob.
// `raw` is expected to be at least two 4 KiB sectors (0x2000 bytes).
export function parseOtaData(raw: Uint8Array): { slot0: OtaSelectEntry; slot1: OtaSelectEntry } {
  return {
    slot0: parseOtaEntry(raw, 0),
    slot1: parseOtaEntry(raw, 0x1000),
  };
}

function parseOtaEntry(raw: Uint8Array, offset: number): OtaSelectEntry {
  if (raw.length < offset + 32) {
    return { seq: 0xffffffff, state: 0xffffffff, stateLabel: "empty", valid: false };
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const seq = dv.getUint32(offset, true) >>> 0;
  const state = dv.getUint32(offset + 24, true) >>> 0;
  const valid = seq !== 0xffffffff;
  return { seq, state, stateLabel: otaStateLabel(state), valid };
}

function otaStateLabel(state: number): string {
  return ({
    0x0: "new",
    0x1: "pending-verify",
    0x2: "valid",
    0x3: "invalid",
    0x4: "aborted",
    0xffffffff: "undefined",
  } as Record<number, string>)[state] ?? `0x${state.toString(16)}`;
}

// Given the two ota_select records and the number of OTA app partitions,
// determine which slot is currently active. Returns -1 if neither record is
// valid (i.e. no OTA ever performed; factory partition is running if present).
export function activeOtaSlot(
  s0: OtaSelectEntry,
  s1: OtaSelectEntry,
  otaCount: number,
): number {
  if (otaCount <= 0) return -1;
  if (!s0.valid && !s1.valid) return -1;
  // Pick whichever has the higher seq.
  const seq = s0.valid && (!s1.valid || s0.seq >= s1.seq) ? s0.seq : s1.seq;
  if (seq === 0 || seq === 0xffffffff) return -1;
  return ((seq - 1) % otaCount) >>> 0;
}
