import type { Buffer } from "node:buffer";
import type { SerialBackend } from "./index.ts";

// Lazy import so the module loads cleanly in RFC2217-only environments.
// deno-lint-ignore no-explicit-any
type SerialPortT = any;

export class LocalSerial implements SerialBackend {
  private sp!: SerialPortT;

  constructor(
    private readonly path: string,
    private readonly baud: number,
  ) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Dynamic import defers the native-module load until needed.
      import("serialport").then(({ SerialPort }) => {
        this.sp = new SerialPort({
          path: this.path,
          baudRate: this.baud,
          autoOpen: false,
        });
        this.sp.open((err: Error | null) => (err ? reject(wrapPermErr(err, this.path)) : resolve()));
      }).catch(reject);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.sp.close(() => resolve()));
  }

  setDtrRts(dtr: boolean, rts: boolean): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sp.set({ dtr, rts }, (err: Error | null) => (err ? reject(err) : resolve()))
    );
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sp.write(bytes, (err: Error | null) => (err ? reject(err) : resolve()))
    );
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = performance.now() + timeoutMs;
    const out: number[] = [];
    while (performance.now() < deadline && out.length < maxBytes) {
      const chunk: Buffer | null = this.sp.read(maxBytes - out.length);
      if (chunk) {
        for (const b of chunk) out.push(b);
      } else {
        await sleep(10);
      }
    }
    return new Uint8Array(out);
  }

  flushInput(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sp.flush((err: Error | null) => (err ? reject(err) : resolve()))
    );
  }
}

function wrapPermErr(err: Error, path: string): Error {
  if (err.message.includes("Permission denied") || (err as NodeJS.ErrnoException).code === "EACCES") {
    return new Error(
      `Permission denied opening ${path}. ` +
      `Add yourself to the dialout group: 'sudo usermod -aG dialout $USER', then log out/in.`,
    );
  }
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
