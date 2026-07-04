// ESP-IDF NVS v2 reader. Format reference: components/nvs_flash/src/nvs_page.hpp.
//
// Partition layout:
//   sequence of 4096-byte pages. Each page:
//     bytes   0..31  : header
//     bytes  32..63  : entry state bitmap (16 entries per 4-byte word, 2 bits each)
//     bytes  64..4095: 126 entries of 32 bytes each
//
// Page header:
//   0..3    state   (u32 LE)   — 0xFFFFFFFE = ACTIVE, 0xFFFFFFFC = FULL, ...
//   4..7    seq     (u32 LE)
//   8       version (u8)       — 0xFE = v2, 0xFF = v1 (single-chunk blobs)
//   9..27   reserved
//   28..31  crc32 of seq+version
//
// Entry (32 bytes):
//   0  nsIndex   (u8)  — 0 => this entry defines a namespace
//   1  type     (u8)
//   2  span     (u8)   — number of 32-byte slots this item occupies
//   3  chunkIdx (u8)
//   4..7   crc32
//   8..23  key (16-byte null-padded ASCII)
//   24..31 data (8 bytes: primitive value OR { size u16, reserved u16, crc32 } for var-len)
//
// Entry states (2 bits each, little-endian packing inside each u32):
//   0b11 (3) = EMPTY        (unprogrammed)
//   0b10 (2) = WRITTEN      (live data — what we care about)
//   0b01 (1) = INVALID
//   0b00 (0) = ERASED

export interface NvsEntry {
  key: string;
  type: string;
  value: string | number | bigint | Uint8Array;
  size?: number; // for var-len
}

export interface NvsNamespace {
  name: string;
  index: number;
  entries: NvsEntry[];
}

export interface NvsParseResult {
  namespaces: NvsNamespace[];
  activePages: number;
  totalPages: number;
  notes: string[];
}

const PAGE_SIZE = 4096;
const HEADER_SIZE = 32;
const BITMAP_SIZE = 32;
const ENTRY_SIZE = 32;
const ENTRIES_PER_PAGE = 126;

// Entry state values (2-bit)
const STATE_WRITTEN = 0b10;

// Page state values (u32 LE)
const PAGE_ACTIVE = 0xfffffffe;
const PAGE_FULL = 0xfffffffc;
const PAGE_FREEING = 0xfffffff8;

// Item types
const TYPE_U8 = 0x01;
const TYPE_I8 = 0x11;
const TYPE_U16 = 0x02;
const TYPE_I16 = 0x12;
const TYPE_U32 = 0x04;
const TYPE_I32 = 0x14;
const TYPE_U64 = 0x08;
const TYPE_I64 = 0x18;
const TYPE_STR = 0x21;
const TYPE_BLOB = 0x41;       // legacy single-span blob
const TYPE_BLOB_DATA = 0x42;  // v2 chunked blob data
const TYPE_BLOB_IDX = 0x48;   // v2 blob index

export function parseNvs(raw: Uint8Array): NvsParseResult {
  const notes: string[] = [];
  const nsByIndex = new Map<number, { name: string; entries: NvsEntry[] }>();
  let activePages = 0;
  const totalPages = Math.floor(raw.length / PAGE_SIZE);

  for (let p = 0; p < totalPages; p++) {
    const pageStart = p * PAGE_SIZE;
    const pageView = new DataView(raw.buffer, raw.byteOffset + pageStart, PAGE_SIZE);
    const state = pageView.getUint32(0, true) >>> 0;
    if (state !== PAGE_ACTIVE && state !== PAGE_FULL && state !== PAGE_FREEING) continue;
    activePages++;

    // Read entry state bitmap (8 × u32 LE)
    const states = new Uint8Array(ENTRIES_PER_PAGE);
    for (let i = 0; i < ENTRIES_PER_PAGE; i++) {
      const word = pageView.getUint32(HEADER_SIZE + Math.floor(i / 16) * 4, true);
      states[i] = (word >>> ((i % 16) * 2)) & 0x3;
    }

    let i = 0;
    while (i < ENTRIES_PER_PAGE) {
      if (states[i] !== STATE_WRITTEN) { i++; continue; }
      const entryOffset = pageStart + HEADER_SIZE + BITMAP_SIZE + i * ENTRY_SIZE;
      const ent = raw.subarray(entryOffset, entryOffset + ENTRY_SIZE);
      const entDv = new DataView(ent.buffer, ent.byteOffset, ent.byteLength);
      const nsIndex = entDv.getUint8(0);
      const type = entDv.getUint8(1);
      const span = Math.max(1, entDv.getUint8(2));
      const key = readKey(ent.subarray(8, 24));

      if (!key) { i += span; continue; }

      // Namespace declaration entry: nsIndex=0, type=U8, key=namespace name, value=index
      if (nsIndex === 0 && type === TYPE_U8) {
        const idx = entDv.getUint8(24);
        if (idx > 0 && !nsByIndex.has(idx)) nsByIndex.set(idx, { name: key, entries: [] });
        i += span;
        continue;
      }

      // Resolve value by type.
      let nvsEntry: NvsEntry | null = null;
      if (isPrimitive(type)) {
        nvsEntry = { key, type: typeLabel(type), value: readPrimitive(type, entDv, 24) };
      } else if (type === TYPE_STR) {
        const parsed = readVarLen(raw, pageStart, i, span, entDv);
        if (parsed) {
          const str = new TextDecoder("utf-8", { fatal: false }).decode(
            parsed.bytes.slice(0, parsed.size > 0 && parsed.bytes[parsed.size - 1] === 0 ? parsed.size - 1 : parsed.size),
          );
          nvsEntry = { key, type: "str", value: str, size: parsed.size };
        }
      } else if (type === TYPE_BLOB || type === TYPE_BLOB_DATA) {
        const parsed = readVarLen(raw, pageStart, i, span, entDv);
        if (parsed) {
          nvsEntry = { key, type: "blob", value: parsed.bytes, size: parsed.size };
        }
      } else if (type === TYPE_BLOB_IDX) {
        // v2 chunked blob index — skip chunk reassembly, just note it exists.
        const size = entDv.getUint32(24, true);
        nvsEntry = { key, type: "blob (chunked)", value: new Uint8Array(0), size };
        notes.push(`${keyWithNs(nsByIndex, nsIndex)}: chunked blob (not reassembled), total ${size} B`);
      } else {
        nvsEntry = { key, type: `unknown (0x${type.toString(16)})`, value: "" };
      }

      if (nvsEntry) {
        let ns = nsByIndex.get(nsIndex);
        if (!ns) {
          ns = { name: `(unresolved ns #${nsIndex})`, entries: [] };
          nsByIndex.set(nsIndex, ns);
        }
        ns.entries.push(nvsEntry);
      }
      i += span;
    }
  }

  const namespaces: NvsNamespace[] = [...nsByIndex.entries()]
    .map(([index, v]) => ({ name: v.name, index, entries: v.entries }))
    .sort((a, b) => a.index - b.index);

  return { namespaces, activePages, totalPages, notes };
}

function readKey(slice: Uint8Array): string {
  const nul = slice.indexOf(0);
  const bytes = nul >= 0 ? slice.slice(0, nul) : slice;
  // Reject non-ASCII keys (probably junk in an empty slot).
  for (const b of bytes) if (b < 0x20 || b > 0x7e) return "";
  return new TextDecoder().decode(bytes);
}

function isPrimitive(type: number): boolean {
  return type === TYPE_U8 || type === TYPE_I8 || type === TYPE_U16 || type === TYPE_I16 ||
    type === TYPE_U32 || type === TYPE_I32 || type === TYPE_U64 || type === TYPE_I64;
}

function typeLabel(type: number): string {
  return ({
    [TYPE_U8]: "u8", [TYPE_I8]: "i8",
    [TYPE_U16]: "u16", [TYPE_I16]: "i16",
    [TYPE_U32]: "u32", [TYPE_I32]: "i32",
    [TYPE_U64]: "u64", [TYPE_I64]: "i64",
  } as Record<number, string>)[type] ?? `0x${type.toString(16)}`;
}

function readPrimitive(type: number, dv: DataView, offset: number): number | bigint {
  switch (type) {
    case TYPE_U8: return dv.getUint8(offset);
    case TYPE_I8: return dv.getInt8(offset);
    case TYPE_U16: return dv.getUint16(offset, true);
    case TYPE_I16: return dv.getInt16(offset, true);
    case TYPE_U32: return dv.getUint32(offset, true);
    case TYPE_I32: return dv.getInt32(offset, true);
    case TYPE_U64: return dv.getBigUint64(offset, true);
    case TYPE_I64: return dv.getBigInt64(offset, true);
  }
  return 0;
}

function readVarLen(
  raw: Uint8Array,
  pageStart: number,
  entryIdx: number,
  span: number,
  entDv: DataView,
): { bytes: Uint8Array; size: number } | null {
  const size = entDv.getUint16(24, true);
  if (size === 0 || span < 1) return { bytes: new Uint8Array(0), size };
  // Data starts at the NEXT entry slot.
  const dataOffset = pageStart + HEADER_SIZE + BITMAP_SIZE + (entryIdx + 1) * ENTRY_SIZE;
  const maxAvailable = (span - 1) * ENTRY_SIZE;
  if (size > maxAvailable) return null;
  const bytes = raw.slice(dataOffset, dataOffset + size);
  return { bytes, size };
}

function keyWithNs(
  nsByIndex: Map<number, { name: string; entries: NvsEntry[] }>,
  nsIndex: number,
): string {
  const ns = nsByIndex.get(nsIndex);
  return ns ? ns.name : `ns#${nsIndex}`;
}
