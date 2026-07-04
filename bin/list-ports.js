#!/usr/bin/env node
// One-shot port enumeration. Prints JSON to stdout and exits.
// Keeps SerialPort.list() out of the Deno main process, which
// some darwin + node-api combinations leave in a half-initialized
// state after the native addon loads.

const { SerialPort } = require("serialport");

SerialPort.list().then(
  (ports) => {
    process.stdout.write(JSON.stringify(ports));
    process.exit(0);
  },
  (err) => {
    process.stderr.write((err && err.message) || String(err));
    process.exit(1);
  },
);
