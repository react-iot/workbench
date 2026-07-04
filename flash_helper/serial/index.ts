import { LocalSerial } from "./local.ts";
import { Rfc2217Serial } from "./rfc2217.ts";

export interface SerialBackend {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Assert both lines atomically (or as close as the transport allows). */
  setDtrRts(dtr: boolean, rts: boolean): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  read(maxBytes: number, timeoutMs: number): Promise<Uint8Array>;
  flushInput(): Promise<void>;
}

export type BackendFactory = (port: string, baud: number) => SerialBackend;

let _factory: BackendFactory | null = null;

/** Override the backend factory — for testing only. */
export function _setBackendFactory(fn: BackendFactory | null): void {
  _factory = fn;
}

export function openSerial(port: string, baud = 115200): SerialBackend {
  if (_factory) return _factory(port, baud);
  if (port.startsWith("rfc2217://")) return new Rfc2217Serial(port, baud);
  return new LocalSerial(port, baud);
}
