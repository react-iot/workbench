#!/usr/bin/env node
// Long-running Node subprocess that owns one serial port.
// Deno main broker talks to it via framed binary over stdin/stdout.
// Isolating serialport's native addon here keeps the Deno runtime from
// wedging on macOS when the binding blocks in the kernel.

const { SerialPort } = require("serialport");

const TYPE_DATA = 0x01;
const TYPE_SETBAUD = 0x02;
const TYPE_BAUD_ACK = 0x03;
const TYPE_ERROR = 0x04;
const TYPE_OPENED = 0x05;
const TYPE_CLOSED = 0x06;
const TYPE_RESET = 0x07; // payload: 1 byte, 0 = normal reset, 1 = enter bootloader
const TYPE_RESET_ACK = 0x08;
const TYPE_SETDTR = 0x09; // payload: 1 byte (0/1 asserted)
const TYPE_SETRTS = 0x0a; // payload: 1 byte (0/1 asserted)
const TYPE_LINES_ACK = 0x0b; // emitted after either DTR or RTS completes
const TYPE_FLASHMODE = 0x0c; // no payload; pre-asserts IO0 LOW then pulses EN

const [, , path, baudStr] = process.argv;
const baudRate = Number(baudStr || 115200);

let dtrState = false;
let rtsState = false;

if (!path) {
  process.stderr.write("usage: serial-worker.js <path> <baud>\n");
  process.exit(2);
}

function send(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header[0] = type;
  header[1] = (payload.length >> 16) & 0xff;
  header[2] = (payload.length >> 8) & 0xff;
  header[3] = payload.length & 0xff;
  process.stdout.write(Buffer.concat([header, payload]));
}

const port = new SerialPort({ path, baudRate, autoOpen: false, lock: false });

port.open((err) => {
  if (err) {
    send(TYPE_ERROR, Buffer.from(err.message, "utf8"));
    process.exit(1);
  }
  send(TYPE_OPENED);
});

port.on("data", (buf) => send(TYPE_DATA, buf));

port.on("close", () => {
  send(TYPE_CLOSED, Buffer.from("port closed", "utf8"));
  process.exit(0);
});

port.on("error", (err) => {
  send(TYPE_ERROR, Buffer.from(err.message, "utf8"));
});

// Parse framed stdin
let rxBuf = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  rxBuf = rxBuf.length === 0 ? chunk : Buffer.concat([rxBuf, chunk]);
  while (rxBuf.length >= 4) {
    const type = rxBuf[0];
    const len = (rxBuf[1] << 16) | (rxBuf[2] << 8) | rxBuf[3];
    if (rxBuf.length < 4 + len) break;
    const payload = rxBuf.subarray(4, 4 + len);
    rxBuf = rxBuf.subarray(4 + len);
    handleFrame(type, payload);
  }
});

process.stdin.on("end", () => {
  try { port.close(); } catch { /* ignore */ }
});

function handleFrame(type, payload) {
  switch (type) {
    case TYPE_DATA:
      port.write(Buffer.from(payload));
      break;
    case TYPE_SETBAUD: {
      if (payload.length !== 4) return;
      const b = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
      port.update({ baudRate: b }, (err) => {
        if (err) send(TYPE_ERROR, Buffer.from(err.message, "utf8"));
        else send(TYPE_BAUD_ACK, Buffer.from(payload));
      });
      break;
    }
    case TYPE_RESET: {
      const bootloader = payload[0] === 1;
      runResetSequence(bootloader);
      break;
    }
    case TYPE_SETDTR: {
      const assertDtr = payload[0] === 1;
      if (assertDtr && rtsState) {
        // EN is already LOW (rtsState=true). A naive setLines(true, true) would trigger
        // the macOS CP210x TIOCMSET read-modify-write glitch: EN briefly pulses HIGH before
        // IO0 goes LOW, causing the chip to sample IO0=HIGH and boot into user mode.
        // Instead, atomically release EN while asserting IO0 in one TIOCMSET call.
        process.stderr.write(`[serial-worker] DTR_ON+RTS=1: atomic EN-release → download mode\n`);
        dtrState = true;
        rtsState = false;
        setLines(true, false).then(
          () => send(TYPE_LINES_ACK),
          (err) => send(TYPE_ERROR, Buffer.from(`setDTR download-mode: ${err.message || err}`, "utf8")),
        );
      } else {
        dtrState = assertDtr;
        setLines(dtrState, rtsState).then(
          () => send(TYPE_LINES_ACK),
          (err) => send(TYPE_ERROR, Buffer.from(`setDTR: ${err.message || err}`, "utf8")),
        );
      }
      break;
    }
    case TYPE_SETRTS: {
      rtsState = payload[0] === 1;
      setLines(dtrState, rtsState).then(
        () => send(TYPE_LINES_ACK),
        (err) => send(TYPE_ERROR, Buffer.from(`setRTS: ${err.message || err}`, "utf8")),
      );
      break;
    }
    case TYPE_FLASHMODE: {
      runFlashModeSequence();
      break;
    }
    default:
      // ignore unknown frames
      break;
  }
}

// ESP32 auto-reset sequence. Standard wiring: DTR→IO0 (boot mode), RTS→EN (reset).
// serialport's boolean matches the asserted state: true = line pulled low.
function setLines(dtr, rts) {
  return new Promise((resolve, reject) => {
    port.set({ dtr, rts }, (err) => {
      if (err) {
        process.stderr.write(`[serial-worker] setLines dtr=${dtr} rts=${rts} ERROR: ${err.message}\n`);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function runResetSequence(bootloader) {
  try {
    if (bootloader) {
      // Classic download-mode entry: pulse IO0 low across a reset pulse.
      // DTR asserted → IO0 pulled low; RTS asserted → EN pulled low (chip in reset).
      await setLines(false, true);   // IO0 high, EN low → chip in reset
      await sleep(100);
      await setLines(true, false);   // IO0 low, EN high → release with strap asserted → download mode
      await sleep(50);
      await setLines(false, false);  // release strap
    } else {
      // Plain reboot: pulse EN low with IO0 high so chip boots into user app.
      // The previous variant only toggled DTR/IO0, which never actually
      // reset the chip — so after Discover the chip stayed in bootloader.
      await setLines(false, true);   // IO0 high, EN low → chip in reset
      await sleep(100);
      await setLines(false, false);  // IO0 high, EN high → chip boots user code
    }
    dtrState = false;
    rtsState = false;
    send(TYPE_RESET_ACK, Buffer.from([bootloader ? 1 : 0]));
  } catch (err) {
    send(TYPE_ERROR, Buffer.from(`reset failed: ${err.message || err}`, "utf8"));
  }
}

async function runFlashModeSequence() {
  try {
    await setLines(false, true);
    await sleep(100);
    await setLines(true, false);
    await sleep(50);
    dtrState = true;
    rtsState = false;
    send(TYPE_RESET_ACK, Buffer.from([2]));
  } catch (err) {
    process.stderr.write(`[serial-worker] flash-mode ERROR: ${err.message || err}\n`);
    send(TYPE_ERROR, Buffer.from(`flash-mode failed: ${err.message || err}`, "utf8"));
  }
}

// Exit cleanly on SIGTERM (parent shutdown)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    try { port.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}
