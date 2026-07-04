// Per-device console log persistence.
//
// Files live in <logDir>/<id>.log. The id is supplied by the client (sanitized
// by us) and expected to be a stable device identifier: "mac:AA-BB-..." or
// "sn:<serial>". ANSI escape sequences are stripped; each line is prefixed
// with an ISO timestamp.
//
// Rotation: when the live file exceeds maxBytes, it is renamed to <id>.log.1
// (overwriting any prior .1), and a fresh file is opened.

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "." : p.slice(0, i);
}

export interface LogWriterOptions {
  logDir: string;
  maxBytes?: number;
}

export function resolveDefaultLogDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return `${home}/.iot-workbench/logs`;
}

export function sanitizeId(raw: string): string {
  // Keep letters, digits, ":", "-", "_", "."; replace the rest with "_".
  // Collapse colons (common in MACs) to dashes so the filename is portable.
  return raw.replace(/[^A-Za-z0-9:._-]/g, "_").replace(/:/g, "-").slice(0, 120);
}

export class LogWriter {
  readonly path: string;
  readonly maxBytes: number;
  private file: Deno.FsFile | null = null;
  private encoder = new TextEncoder();
  private pending = ""; // unterminated tail from the last chunk
  private bytesWritten = 0;

  constructor(id: string, opts: LogWriterOptions) {
    const safeId = sanitizeId(id);
    if (!safeId) throw new Error("log id resolves to empty after sanitize");
    this.path = `${opts.logDir}/${safeId}.log`;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  }

  async open(): Promise<void> {
    await Deno.mkdir(dirname(this.path), { recursive: true });
    try {
      const st = await Deno.stat(this.path);
      this.bytesWritten = st.size;
    } catch {
      this.bytesWritten = 0;
    }
    this.file = await Deno.open(this.path, { create: true, append: true });
  }

  get size(): number {
    return this.bytesWritten;
  }

  // Accepts raw serial bytes; strips ANSI, groups by line, prepends ISO
  // timestamp per line. Unterminated tail is held for the next call.
  async writeBytes(chunk: Uint8Array): Promise<void> {
    if (!this.file) return;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(chunk);
    const clean = text.replace(ANSI, "").replace(/\r\n?/g, "\n");
    this.pending += clean;

    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    if (lines.length === 0) return;

    const stamp = new Date().toISOString();
    const out = lines.map((l) => `[${stamp}] ${l}\n`).join("");
    await this.#writeRaw(this.encoder.encode(out));
  }

  async flushPending(): Promise<void> {
    if (!this.file || !this.pending) return;
    const stamp = new Date().toISOString();
    await this.#writeRaw(this.encoder.encode(`[${stamp}] ${this.pending}\n`));
    this.pending = "";
  }

  async #writeRaw(bytes: Uint8Array): Promise<void> {
    if (!this.file) return;
    await this.file.write(bytes);
    this.bytesWritten += bytes.byteLength;
    if (this.bytesWritten >= this.maxBytes) await this.#rotate();
  }

  async #rotate(): Promise<void> {
    if (!this.file) return;
    try { this.file.close(); } catch { /* already closed */ }
    this.file = null;
    const rolled = `${this.path}.1`;
    try { await Deno.remove(rolled); } catch { /* missing is fine */ }
    try { await Deno.rename(this.path, rolled); } catch { /* target gone? */ }
    this.bytesWritten = 0;
    this.file = await Deno.open(this.path, { create: true, append: true });
  }

  async close(): Promise<void> {
    try { await this.flushPending(); } catch { /* ignore */ }
    if (this.file) {
      try { this.file.close(); } catch { /* already closed */ }
      this.file = null;
    }
  }
}
