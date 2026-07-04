#!/usr/bin/env -S deno run -A
import { parseArgs } from "jsr:@std/cli/parse-args";
import { enterBootloader, hardReset, verify } from "./mod.ts";

const COMMANDS = ["enter-bootloader", "hard-reset", "verify"] as const;
type Command = typeof COMMANDS[number];

const USAGE = `
Usage: flash-helper <command> --port <port> [options]

Commands:
  enter-bootloader   Assert GPIO0 LOW then release EN → ROM download mode
  hard-reset         Pulse EN LOW then HIGH → normal boot from flash
  verify             Send SLIP sync; exit 0 if bootloader responds

Options:
  --port <port>           Serial port or rfc2217://host:port  (required)
  --reset-hold-ms <ms>    EN-low hold duration  (default 120)
  --gpio0-hold-ms <ms>    GPIO0-low hold after EN release  (default 80)
  --verbose               Print timing log to stderr
  --help                  Show this help
`.trim();

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["port", "reset-hold-ms", "gpio0-hold-ms"],
    boolean: ["verbose", "help"],
    alias: { h: "help", v: "verbose" },
  });

  if (args.help || args._.length === 0) {
    console.log(USAGE);
    Deno.exit(0);
  }

  const cmd = String(args._[0]) as Command;
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
    Deno.exit(1);
  }

  const port = args.port;
  if (!port) {
    console.error("--port is required");
    Deno.exit(1);
  }

  const opts = {
    resetHoldMs: args["reset-hold-ms"] ? parseInt(args["reset-hold-ms"], 10) : undefined,
    gpio0HoldMs: args["gpio0-hold-ms"] ? parseInt(args["gpio0-hold-ms"], 10) : undefined,
    verbose: args.verbose,
    logger: (msg: string) => console.error(`[flash-helper] ${msg}`),
  };

  try {
    if (cmd === "enter-bootloader") {
      await enterBootloader(port, opts);
    } else if (cmd === "hard-reset") {
      await hardReset(port, opts);
    } else {
      const ok = await verify(port, opts);
      if (!ok) {
        console.error("verify: no response from bootloader");
        Deno.exit(3);
      }
      console.log("verify: bootloader responded OK");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Permission denied") || msg.includes("EACCES")) {
      console.error(`Error: ${msg}`);
      Deno.exit(2);
    }
    if (msg.includes("No such file") || msg.includes("ENOENT") || msg.includes("connect ECONNREFUSED")) {
      console.error(`Error: could not open port: ${msg}`);
      Deno.exit(2);
    }
    console.error(`Error: ${msg}`);
    Deno.exit(1);
  }
}

main();
