// ESP-IDF partition table format. 32 bytes per entry; ends at an entry
// starting with the MD5 marker or a row of 0xFF (unprogrammed flash).
// Reference: ESP-IDF components/partition_table/partition_table.csv + docs.

export interface PartitionEntry {
  name: string;
  type: string;     // "app" | "data" | "<raw 0xXX>"
  subtype: string;  // resolved label when known, otherwise "0xXX"
  offset: number;
  size: number;
  encrypted: boolean;
}

const MAGIC_ENTRY = 0x50aa; // little-endian: 0xAA, 0x50
const MAGIC_MD5 = 0xebeb;   // little-endian: 0xEB, 0xEB — MD5 checksum row

const TYPE_NAMES: Record<number, string> = {
  0x00: "app",
  0x01: "data",
};

// Subtype tables keyed by type.
const APP_SUBTYPES: Record<number, string> = {
  0x00: "factory",
  0x10: "ota_0",
  0x11: "ota_1",
  0x12: "ota_2",
  0x13: "ota_3",
  0x14: "ota_4",
  0x15: "ota_5",
  0x16: "ota_6",
  0x17: "ota_7",
  0x20: "test",
};
const DATA_SUBTYPES: Record<number, string> = {
  0x00: "ota",
  0x01: "phy",
  0x02: "nvs",
  0x03: "coredump",
  0x04: "nvs_keys",
  0x05: "efuse",
  0x06: "undefined",
  0x80: "esphttpd",
  0x81: "fat",
  0x82: "spiffs",
  0x83: "littlefs",
};

export function parsePartitionTable(raw: Uint8Array): PartitionEntry[] {
  const out: PartitionEntry[] = [];
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const td = new TextDecoder("utf-8");

  for (let off = 0; off + 32 <= raw.length; off += 32) {
    const magic = dv.getUint16(off, true);
    if (magic === MAGIC_MD5) break;            // end of table
    if (magic !== MAGIC_ENTRY) {
      // All 0xFF → unprogrammed sector → end.
      if (raw[off] === 0xff && raw[off + 1] === 0xff) break;
      continue;                                 // skip malformed row
    }

    const typeByte = dv.getUint8(off + 2);
    const subtypeByte = dv.getUint8(off + 3);
    const partOffset = dv.getUint32(off + 4, true);
    const partSize = dv.getUint32(off + 8, true);
    const nameBytes = raw.slice(off + 12, off + 28);
    const flags = dv.getUint32(off + 28, true);

    const nulIdx = nameBytes.indexOf(0);
    const name = td.decode(nulIdx >= 0 ? nameBytes.slice(0, nulIdx) : nameBytes);

    const typeLabel = TYPE_NAMES[typeByte] ?? `0x${typeByte.toString(16).padStart(2, "0")}`;
    const subtypeTable = typeByte === 0x00 ? APP_SUBTYPES : typeByte === 0x01 ? DATA_SUBTYPES : null;
    const subtypeLabel = subtypeTable?.[subtypeByte] ?? `0x${subtypeByte.toString(16).padStart(2, "0")}`;

    out.push({
      name,
      type: typeLabel,
      subtype: subtypeLabel,
      offset: partOffset,
      size: partSize,
      encrypted: (flags & 0x1) === 0x1,
    });
  }
  return out;
}
