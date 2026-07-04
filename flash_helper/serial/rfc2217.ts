import type { Buffer } from "node:buffer";
import * as net from "node:net";
import type { SerialBackend } from "./index.ts";

// Telnet / RFC 2217 protocol constants
const IAC = 0xff;
const SB  = 0xfa;
const SE  = 0xf0;
const WILL = 0xfb;
const DO   = 0xfd;
const COM_PORT_OPTION = 0x2c; // 44
const CAS_SET_CONTROL = 0x05; // client→server set-control command

const DTR_ON  = 8;
const DTR_OFF = 9;
const RTS_ON  = 11;
const RTS_OFF = 12;

export class Rfc2217Serial implements SerialBackend {
  private sock!: net.Socket;
  private rxBuf: number[] = [];
  private readonly host: string;
  private readonly port: number;

  constructor(url: string, _baud: number) {
    const parsed = parseRfc2217Url(url);
    this.host = parsed.host;
    this.port = parsed.port;
  }

  async open(): Promise<void> {
    this.sock = await connectTcp(this.host, this.port);
    this.sock.setNoDelay(true);
    this.sock.on("data", (buf: Buffer) => this.ingest(buf));
    // Announce that we want to use the COM-PORT-OPTION.
    this.sendRaw(new Uint8Array([IAC, DO, COM_PORT_OPTION]));
    // Brief pause for the server to process the negotiation.
    await sleep(100);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.sock.end(() => resolve());
    });
  }

  async setDtrRts(dtr: boolean, rts: boolean): Promise<void> {
    this.sendSubneg(dtr ? DTR_ON : DTR_OFF);
    this.sendSubneg(rts ? RTS_ON : RTS_OFF);
    // Flush TCP buffers so packets are sent before the caller sleeps.
    await sleep(5);
  }

  write(bytes: Uint8Array): Promise<void> {
    const escaped = escapeIac(bytes);
    return new Promise((resolve, reject) =>
      this.sock.write(escaped, (err?: Error | null) => (err ? reject(err) : resolve()))
    );
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = performance.now() + timeoutMs;
    while (this.rxBuf.length < maxBytes && performance.now() < deadline) {
      await sleep(5);
    }
    const take = Math.min(maxBytes, this.rxBuf.length);
    const out = Uint8Array.from(this.rxBuf.slice(0, take));
    this.rxBuf.splice(0, take);
    return out;
  }

  flushInput(): Promise<void> {
    this.rxBuf.length = 0;
    return Promise.resolve();
  }

  // ---- private ----

  private sendRaw(bytes: Uint8Array): void {
    this.sock.write(bytes);
  }

  private sendSubneg(value: number): void {
    this.sendRaw(
      new Uint8Array([IAC, SB, COM_PORT_OPTION, CAS_SET_CONTROL, value, IAC, SE]),
    );
  }

  /** Strip telnet commands from incoming bytes and enqueue plain data. */
  private ingest(buf: Buffer): void {
    let i = 0;
    while (i < buf.length) {
      const b = buf[i];
      if (b !== IAC) {
        this.rxBuf.push(b);
        i++;
        continue;
      }
      // IAC — check next byte
      if (i + 1 >= buf.length) break; // incomplete; remainder arrives in next chunk
      const next = buf[i + 1];
      if (next === IAC) {
        // Escaped 0xFF data byte
        this.rxBuf.push(IAC);
        i += 2;
      } else if (next === SB) {
        // Subnegotiation: IAC SB ... IAC SE — skip entire block
        const end = findIacSe(buf, i + 2);
        i = end === -1 ? buf.length : end + 1;
      } else {
        // 2-byte telnet command: IAC WILL/WONT/DO/DONT <opt>
        // and other 2-byte forms — skip both bytes + option byte if applicable
        if (next === WILL || next === DO || next === 0xfc || next === 0xfe) {
          i += 3; // IAC + cmd + option
        } else {
          i += 2; // IAC + single-byte command
        }
      }
    }
  }
}

// ---- helpers ----

function findIacSe(buf: Buffer, from: number): number {
  for (let j = from; j < buf.length - 1; j++) {
    if (buf[j] === IAC && buf[j + 1] === SE) return j + 1;
  }
  return -1;
}

function escapeIac(data: Uint8Array): Uint8Array {
  let count = 0;
  for (const b of data) if (b === IAC) count++;
  if (count === 0) return data;
  const out = new Uint8Array(data.length + count);
  let j = 0;
  for (const b of data) {
    out[j++] = b;
    if (b === IAC) out[j++] = IAC;
  }
  return out;
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port }, () => resolve(s));
    s.once("error", reject);
  });
}

function parseRfc2217Url(url: string): { host: string; port: number } {
  // rfc2217://host:port?query
  const withoutScheme = url.slice("rfc2217://".length);
  const [hostPort] = withoutScheme.split("?");
  const lastColon = hostPort.lastIndexOf(":");
  const host = hostPort.slice(0, lastColon);
  const port = parseInt(hostPort.slice(lastColon + 1), 10);
  return { host, port };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
