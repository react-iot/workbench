import { attach, type Handle } from "./serial.ts";

const IAC = 0xff;
const DONT = 0xfe;
const DO = 0xfd;
const WONT = 0xfc;
const WILL = 0xfb;
const SB = 0xfa;
const SE = 0xf0;

const COM_PORT_OPTION = 0x2c; // 44

// Client → server subneg commands (RFC 2217 §3)
const CLIENT_SET_BAUDRATE = 1;
const CLIENT_SET_DATASIZE = 2;
const CLIENT_SET_PARITY = 3;
const CLIENT_SET_STOPSIZE = 4;
const CLIENT_SET_CONTROL = 5;
const CLIENT_PURGE_DATA = 12;

// SET_CONTROL payload values for DTR/RTS (per pyserial rfc2217.py)
const CONTROL_DTR_ON = 8;   // 0x08
const CONTROL_DTR_OFF = 9;  // 0x09
const CONTROL_RTS_ON = 11;  // 0x0b
const CONTROL_RTS_OFF = 12; // 0x0c

// Server responses are client + 100
const SERVER_SET_BAUDRATE = 101;
const SERVER_SET_DATASIZE = 102;
const SERVER_SET_PARITY = 103;
const SERVER_SET_STOPSIZE = 104;
const SERVER_SET_CONTROL = 105;
const SERVER_PURGE_DATA = 112;

const BASE_PORT = 4001;
const MAX_PORT = 4100;
const DEFAULT_BAUD = 115200;

interface Assignment {
  path: string;
  tcpPort: number;
  listener?: Deno.Listener;
  loggedFailure?: boolean;
}

export class Rfc2217Manager {
  private byPath = new Map<string, Assignment>();
  private usedPorts = new Set<number>();
  private hostname: string;

  constructor(hostname = "0.0.0.0") {
    this.hostname = hostname;
  }

  sync(paths: string[]): void {
    const active = new Set(paths);
    for (const [p, a] of this.byPath) {
      if (!active.has(p) && a.listener) {
        try {
          a.listener.close();
        } catch { /* ignore */ }
        a.listener = undefined;
      }
    }
    for (const p of paths) {
      const existing = this.byPath.get(p);
      if (!existing) {
        const fresh = this.allocateAndListen(p);
        if (fresh) this.byPath.set(p, fresh);
        continue;
      }
      const a = existing;
      if (!a.listener) {
        try {
          a.listener = this.bind(a.tcpPort, a.path);
          a.loggedFailure = false;
        } catch (err) {
          if (!a.loggedFailure) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`RFC2217 listen failed for ${a.path} on :${a.tcpPort}: ${msg}`);
            a.loggedFailure = true;
          }
        }
      }
    }
  }

  getAssignments(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [p, a] of this.byPath) {
      if (a.listener) out.set(p, a.tcpPort);
    }
    return out;
  }

  private allocateAndListen(path: string): Assignment | null {
    for (let p = BASE_PORT; p <= MAX_PORT; p++) {
      if (this.usedPorts.has(p)) continue;
      try {
        const listener = this.bind(p, path);
        this.usedPorts.add(p);
        return { path, tcpPort: p, listener };
      } catch {
        // port busy; try next
      }
    }
    console.error(`RFC2217 could not bind any port in ${BASE_PORT}-${MAX_PORT} for ${path}`);
    return null;
  }

  private bind(tcpPort: number, path: string): Deno.Listener {
    const listener = Deno.listen({ port: tcpPort, hostname: this.hostname, transport: "tcp" });
    console.log(`RFC2217 ${path} -> tcp://${this.hostname}:${tcpPort}`);
    this.acceptLoop(listener, path);
    return listener;
  }

  private acceptLoop(listener: Deno.Listener, path: string): void {
    (async () => {
      for await (const conn of listener) {
        handleClient(path, conn).catch((err) => {
          console.error(`rfc2217 client error on ${path}:`, err);
          try { conn.close(); } catch { /* ignore */ }
        });
      }
    })();
  }

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

class TelnetParser {
  private state: "data" | "iac" | "opt" | "sb" | "sb_iac" = "data";
  private optCmd = 0;
  private sb: number[] = [];

  constructor(
    private readonly onData: (chunk: Uint8Array) => void,
    private readonly onCommand: (cmd: number, opt: number) => void,
    private readonly onSubneg: (data: Uint8Array) => void,
  ) {}

  feed(chunk: Uint8Array): void {
    const passthrough: number[] = [];
    const flushPassthrough = () => {
      if (passthrough.length) {
        this.onData(Uint8Array.from(passthrough));
        passthrough.length = 0;
      }
    };

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      switch (this.state) {
        case "data":
          if (b === IAC) this.state = "iac";
          else passthrough.push(b);
          break;
        case "iac":
          if (b === IAC) {
            // escaped 0xFF
            passthrough.push(IAC);
            this.state = "data";
          } else if (b === SB) {
            flushPassthrough();
            this.sb = [];
            this.state = "sb";
          } else if (b === WILL || b === WONT || b === DO || b === DONT) {
            this.optCmd = b;
            this.state = "opt";
          } else {
            // ignore single-byte commands (NOP, etc.)
            this.state = "data";
          }
          break;
        case "opt":
          flushPassthrough();
          this.onCommand(this.optCmd, b);
          this.state = "data";
          break;
        case "sb":
          if (b === IAC) this.state = "sb_iac";
          else this.sb.push(b);
          break;
        case "sb_iac":
          if (b === IAC) {
            this.sb.push(IAC);
            this.state = "sb";
          } else if (b === SE) {
            this.onSubneg(Uint8Array.from(this.sb));
            this.sb = [];
            this.state = "data";
          } else {
            // Unexpected; drop back to data
            this.sb = [];
            this.state = "data";
          }
          break;
      }
    }
    flushPassthrough();
  }
}

const CMD_NAMES: Record<number, string> = {
  [WILL]: "WILL", [WONT]: "WONT", [DO]: "DO", [DONT]: "DONT",
};
const SUBNEG_NAMES: Record<number, string> = {
  [CLIENT_SET_BAUDRATE]: "SET_BAUDRATE", [CLIENT_SET_DATASIZE]: "SET_DATASIZE",
  [CLIENT_SET_PARITY]: "SET_PARITY", [CLIENT_SET_STOPSIZE]: "SET_STOPSIZE",
  [CLIENT_SET_CONTROL]: "SET_CONTROL", [CLIENT_PURGE_DATA]: "PURGE_DATA",
  [SERVER_SET_BAUDRATE]: "SRV_BAUDRATE", [SERVER_SET_DATASIZE]: "SRV_DATASIZE",
  [SERVER_SET_PARITY]: "SRV_PARITY", [SERVER_SET_STOPSIZE]: "SRV_STOPSIZE",
  [SERVER_SET_CONTROL]: "SRV_CONTROL", [SERVER_PURGE_DATA]: "SRV_PURGE_DATA",
};

async function handleClient(path: string, conn: Deno.Conn): Promise<void> {
  const id = `rfc2217-${crypto.randomUUID()}`;
  const tag = `[rfc2217 ${path} ${id.slice(-8)}]`;
  const writer = conn.writable.getWriter();
  let closed = false;

  const safeWrite = async (bytes: Uint8Array) => {
    if (closed) return;
    try {
      await writer.write(bytes);
    } catch {
      closed = true;
    }
  };

  const sendSubneg = (body: number[], log = false) => {
    if (log) {
      const name = SUBNEG_NAMES[body[0]] ?? `cmd=${body[0]}`;
      console.log(`${tag} → ${name} [${body.slice(1).join(",")}]`);
    }
    const frame = new Uint8Array(3 + body.length + 2);
    frame[0] = IAC;
    frame[1] = SB;
    frame[2] = COM_PORT_OPTION;
    frame.set(body, 3);
    frame[3 + body.length] = IAC;
    frame[3 + body.length + 1] = SE;
    safeWrite(frame).catch(() => {});
  };

  // CP210x on macOS is unreliable at 460800+ baud (USB polling latency means the UART
  // doesn't stabilize before the first byte). 230400 is the highest reliable rate.
  const MAX_FLASH_BAUD = 230400;

  // Set true when esptool changes baud above 115200 (stub is running, flash underway).
  // Suppresses hardware DTR/RTS changes that could reset the chip mid-flash, while
  // still ACKing SET_CONTROL so esptool doesn't stall.
  let ignoreSetControl = false;

  let handle: Handle | null = null;

  try {
    console.log(`${tag} connected`);
    handle = await attach(path, DEFAULT_BAUD, {
      id,
      onData: (chunk) => {
        safeWrite(escapeIac(chunk)).catch(() => {});
      },
      onClose: () => {
        closed = true;
        try {
          conn.close();
        } catch { /* ignore */ }
      },
    });
    console.log(`${tag} serial attached`);

    // Announce COM-PORT-OPTION only after the serial port is open so we can
    // respond to the client's immediate subneg flood (baud/purge) without
    // timing out while the worker is still starting up.
    await safeWrite(new Uint8Array([IAC, WILL, COM_PORT_OPTION]));

    // Intercept ESP_CHANGE_BAUDRATE SLIP frames from esptool before forwarding
    // to the chip. If the requested baud exceeds MAX_FLASH_BAUD, rewrite the frame
    // with the capped value (and a corrected XOR checksum) so the stub and the
    // RFC2217 SRV_BAUDRATE response agree on the same rate.
    //
    // SLIP frame layout (18 bytes, no escaping needed for these baud values):
    //   C0  00  0F  08 00  [chk:4]  [new_baud:4 LE]  [old_baud:4 LE]  C0
    //    0   1   2   3  4   5-8        9-12              13-16          17
    function capSlipBaud(data: Uint8Array): Uint8Array {
      for (let i = 0; i <= data.length - 18; i++) {
        if (
          data[i] === 0xc0 && data[i + 1] === 0x00 &&
          data[i + 2] === 0x0f && data[i + 3] === 0x08 &&
          data[i + 4] === 0x00 && data[i + 17] === 0xc0
        ) {
          const requested =
            (data[i + 9] | (data[i + 10] << 8) | (data[i + 11] << 16) | (data[i + 12] << 24)) >>> 0;
          if (requested > MAX_FLASH_BAUD) {
            const cap = MAX_FLASH_BAUD;
            const out = new Uint8Array(data);
            out[i + 9]  =  cap & 0xff;
            out[i + 10] = (cap >> 8) & 0xff;
            out[i + 11] = (cap >> 16) & 0xff;
            out[i + 12] = (cap >> 24) & 0xff;
            // Checksum = 0xEF XOR all 8 data bytes (esptool's ESP_CHECKSUM_MAGIC = 0xEF)
            const chk = 0xef ^
              out[i + 9] ^ out[i + 10] ^ out[i + 11] ^ out[i + 12] ^
              out[i + 13] ^ out[i + 14] ^ out[i + 15] ^ out[i + 16];
            out[i + 5] = chk; out[i + 6] = 0; out[i + 7] = 0; out[i + 8] = 0;
            console.log(`${tag} ESP_CHANGE_BAUDRATE: ${requested} → ${cap} (capped)`);
            return out;
          }
        }
      }
      return data;
    }

    const parser = new TelnetParser(
      (data) => {
        handle!.write(capSlipBaud(data));
      },
      (cmd, opt) => {
        if (opt === COM_PORT_OPTION) {
          // Client DO COM-PORT-OPTION: we already announced WILL; ignore.
          // Client WILL COM-PORT-OPTION: reply DO so client may send subneg.
          if (cmd === WILL) {
            safeWrite(new Uint8Array([IAC, DO, COM_PORT_OPTION])).catch(() => {});
          }
          return;
        }
        // Reject other options
        if (cmd === DO) {
          safeWrite(new Uint8Array([IAC, WONT, opt])).catch(() => {});
        } else if (cmd === WILL) {
          safeWrite(new Uint8Array([IAC, DONT, opt])).catch(() => {});
        }
      },
      (sub) => {
        if (sub.length === 0 || sub[0] !== COM_PORT_OPTION) return;
        const cmd = sub[1];
        const payload = sub.slice(2);
        if (cmd === CLIENT_SET_BAUDRATE && payload.length === 4) {
          const baud = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
          const cur = handle!.getBaud();
          if (baud === 0 || baud === cur) {
            sendSubneg([
              SERVER_SET_BAUDRATE,
              (cur >>> 24) & 0xff,
              (cur >>> 16) & 0xff,
              (cur >>> 8) & 0xff,
              cur & 0xff,
            ]);
          } else {
            // Cap to the max reliable baud for this adapter/OS combination.
            const effective = Math.min(baud, MAX_FLASH_BAUD);
            if (effective !== baud) {
              console.log(`${tag} baud ${cur} → ${baud} (capped to ${effective})`);
            } else {
              console.log(`${tag} baud ${cur} → ${baud}`);
            }
            if (baud > DEFAULT_BAUD) {
              ignoreSetControl = true;
              console.log(`${tag} baud > ${DEFAULT_BAUD}: DTR/RTS suppressed for flash session`);
            }
            // Wait for the hardware baud change to complete before ACKing.
            // The stub (or ROM) sends its baud-change response at the old baud,
            // which the hardware handles correctly while still at the old rate.
            // Delaying SRV_BAUDRATE ensures the hardware is at the new rate
            // before esptool starts sending commands at the new baud over TCP.
            handle!.setBaud(effective).then(() => {
              sendSubneg([
                SERVER_SET_BAUDRATE,
                (effective >>> 24) & 0xff,
                (effective >>> 16) & 0xff,
                (effective >>> 8) & 0xff,
                effective & 0xff,
              ]);
            }).catch((err) => {
              console.error(`${tag} setBaud failed: ${err.message ?? err}`);
              sendSubneg([
                SERVER_SET_BAUDRATE,
                (effective >>> 24) & 0xff,
                (effective >>> 16) & 0xff,
                (effective >>> 8) & 0xff,
                effective & 0xff,
              ]);
            });
          }
        } else if (cmd === CLIENT_SET_CONTROL) {
          const val = payload[0];
          if (!ignoreSetControl) {
            if (val === CONTROL_DTR_ON) {
              handle!.setDtr(true)
                .catch((err) => console.error(`${tag} setDtr failed: ${err.message ?? err}`));
            } else if (val === CONTROL_DTR_OFF) {
              handle!.setDtr(false)
                .catch((err) => console.error(`${tag} setDtr failed: ${err.message ?? err}`));
            } else if (val === CONTROL_RTS_ON) {
              handle!.setRts(true)
                .catch((err) => console.error(`${tag} setRts failed: ${err.message ?? err}`));
            } else if (val === CONTROL_RTS_OFF) {
              handle!.setRts(false)
                .catch((err) => console.error(`${tag} setRts failed: ${err.message ?? err}`));
            }
          }
          sendSubneg([SERVER_SET_CONTROL, ...Array.from(payload)]);
        } else if (
          cmd === CLIENT_SET_DATASIZE ||
          cmd === CLIENT_SET_PARITY ||
          cmd === CLIENT_SET_STOPSIZE ||
          cmd === CLIENT_PURGE_DATA
        ) {
          // Echo back the requested value as an acknowledgement — no log needed.
          sendSubneg([cmd + 100, ...Array.from(payload)]);
        }
      },
    );

    for await (const chunk of conn.readable) {
      parser.feed(chunk);
      if (closed) break;
    }
  } finally {
    console.log(`${tag} disconnected`);
    closed = true;
    handle?.detach();
    try {
      writer.releaseLock();
    } catch { /* ignore */ }
    try {
      conn.close();
    } catch { /* ignore */ }
  }
}
