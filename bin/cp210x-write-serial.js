#!/usr/bin/env node
// Rewrite a CP210x USB string descriptor (serial or product).
// Usage:
//   cp210x-write-serial.js <vidHex> <pidHex> <currentSerial|-> <newValue> [field]
//     field: "serial" (default) | "product"
//
// Protocol (AN721 / cp210x-program):
//   bmRequestType = 0x40     (vendor OUT to device)
//   bRequest      = 0xFF     (vendor specific)
//   wValue        = 0x04     (REG_SERIAL_STR) or 0x03 (REG_PRODUCT_STRING)
//   wIndex        = 0x0000
//   data          = [len_bytes, 0x03, UTF-16-LE bytes]
//
// Emits one line of JSON on stdout with { ok, error?, platformHint?, wrote?, field? }.

const usb = require("usb");

function done(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(obj.ok ? 0 : 1);
}

const [, , vidHex, pidHex, currentSerial, newValue, fieldRaw = "serial"] = process.argv;
if (!vidHex || !pidHex || !newValue) {
  done({ ok: false, error: "usage: cp210x-write-serial.js <vidHex> <pidHex> <currentSerial|-> <newValue> [field]" });
}
const field = String(fieldRaw).toLowerCase();
const REG = field === "product" ? 0x0003 : 0x0004;
if (field !== "serial" && field !== "product") {
  done({ ok: false, error: `unknown field '${fieldRaw}', expected 'serial' or 'product'` });
}

const vid = parseInt(vidHex, 16);
const pid = parseInt(pidHex, 16);
if (!Number.isFinite(vid) || !Number.isFinite(pid)) {
  done({ ok: false, error: `bad VID/PID: ${vidHex}:${pidHex}` });
}

// Pick the right device. If a current-serial hint is given and multiple CP210x
// are connected, match it; otherwise pick the first one matching VID:PID.
function findDevice() {
  const devices = usb.getDeviceList();
  const matches = devices.filter((d) =>
    d.deviceDescriptor.idVendor === vid && d.deviceDescriptor.idProduct === pid,
  );
  if (!matches.length) return null;
  if (matches.length === 1 || !currentSerial || currentSerial === "-") return matches[0];
  // Try to match by reading current serial — requires opening each briefly.
  for (const d of matches) {
    try {
      d.open();
      const idx = d.deviceDescriptor.iSerialNumber;
      if (idx) {
        const serial = readStringSync(d, idx);
        d.close();
        if (serial === currentSerial) return d;
        continue;
      }
      d.close();
    } catch {
      try { d.close(); } catch { /* ignore */ }
    }
  }
  return matches[0];
}

function readStringSync(device, idx) {
  return new Promise((resolve, reject) => {
    device.getStringDescriptor(idx, (err, value) => err ? reject(err) : resolve(value));
  });
}

async function run() {
  const device = findDevice();
  if (!device) {
    return done({ ok: false, error: `no device with VID:PID ${vidHex}:${pidHex} found on this host` });
  }

  try {
    device.open();
  } catch (err) {
    return done({
      ok: false,
      error: `device.open failed: ${err.message}`,
      platformHint:
        "Ensure the user running this server has udev access to the CP210x. A working rule for /etc/udev/rules.d/99-cp210x.rules: " +
        `SUBSYSTEM=="usb", ATTRS{idVendor}=="${vidHex}", ATTRS{idProduct}=="${pidHex}", MODE="0666". ` +
        "Reload with: sudo udevadm control --reload && sudo udevadm trigger.",
    });
  }

  try {
    // Try to detach any kernel driver holding the interface. On Linux this is
    // the usbserial module; on macOS it's the CP210xVCPDriver kext (may
    // refuse). No-op on Windows.
    try {
      const iface = device.interface(0);
      if (iface && typeof iface.isKernelDriverActive === "function" && iface.isKernelDriverActive()) {
        iface.detachKernelDriver();
      }
    } catch (_) { /* best-effort */ }

    // Build the USB string descriptor payload.
    const utf16 = Buffer.from(newValue, "utf16le");
    const descriptor = Buffer.concat([Buffer.from([utf16.length + 2, 0x03]), utf16]);

    await new Promise((resolve, reject) => {
      device.controlTransfer(0x40, 0xff, REG, 0x0000, descriptor, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    done({ ok: true, wrote: newValue, field });
  } catch (err) {
    done({
      ok: false,
      error: `controlTransfer failed: ${err.message}`,
      platformHint:
        "On Linux the usbserial driver is normally detached automatically. If this fails, try rmmod cp210x once, run again, then modprobe cp210x.",
    });
  } finally {
    try { device.close(); } catch { /* ignore */ }
  }
}

run();
