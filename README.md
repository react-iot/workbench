# ESP32 Workbench

**Flash-mode control, chip discovery, and a serial console for ESP32-family microcontrollers — in your browser, over USB or the network.**

ESP32 Workbench is a self-hosted web app for working with ESP32 boards. It pairs a real terminal with one-click chip discovery — reading the chip identity, partition table, OTA slots, and NVS in a single pass — and exposes every serial port over the network so tools like `esptool` and `idf.py` can reach a board on your bench from anywhere on the LAN. No local toolchain to install for the operator: just open a browser tab.

Built by [React IoT](https://www.reactiot.com.au) on [Deno](https://deno.com), [esptool-js](https://github.com/espressif/esptool-js), and [xterm.js](https://xtermjs.org).

---

## Features

- **Serial console** — full xterm.js terminal with baud selection, line-ending control, `Ctrl+C`, and ESP-IDF log colouring (info/warn/error tinted to theme).
- **USB *and* network serial** — talk to a board plugged in locally, or bridge any port over TCP with **RFC2217** so remote tools can connect.
- **mDNS auto-discovery** — the server and each RFC2217 port are advertised on the LAN (`_esp32-workbench._tcp`, `_rfc2217._tcp`).
- **One-pass Discover** — reads chip info (type, MAC, revision, crystal, flash size, features), the partition table, OTA app slots, and NVS in one click.
- **Partition & OTA visualisation** — flash-layout map, OTA slot inspector with running/valid state, and a full partition-entry table.
- **NVS inspector** — browse namespaces, keys, types, and values (read-only).
- **Flash-mode & reset control** — enter the ROM download bootloader or hard-reset the board, with a DTR/RTS sequence tuned for the macOS CP210x quirk.
- **MD5 verify** — hash any offset/length range of flash to confirm contents.
- **CP210x string rewrite** — change the USB serial number / product string of Silicon Labs CP210x adapters.
- **Per-device log history** — persistent, rotating session logs per port.
- **Light / Dark / Auto theming**, installable as a PWA.
- **MCP interface** — an HTTP [Model Context Protocol](https://modelcontextprotocol.io) endpoint (`POST /mcp`) so AI agents (Claude, etc.) can list ports, discover a device, reset it, and tail the console. See [DEPLOY.md](DEPLOY.md#mcp-endpoint-for-ai-agents).

**Roadmap (UI present, backend in progress):** firmware flashing and on-device filesystem (SPIFFS/LittleFS/FATFS) browsing — the tabs exist but are not yet wired end-to-end. Flash today with `esptool`/`idf.py` over the network serial bridge (below).

---

## Requirements

- **[Deno](https://deno.com) 2.x** — runs the HTTP/WebSocket server and all device logic.
- **[Node.js](https://nodejs.org) 18+** — the server spawns `node` for the serial-I/O worker (native `serialport`) and the CP210x rewrite helper. Node must be on your `PATH`.
- A **C/C++ build toolchain** — the `serialport` and `usb` npm modules are native addons and are compiled on first install (Xcode CLT on macOS, `build-essential` on Linux).
- **macOS or Linux** with drivers for your USB-serial adapter (CP210x, CH340, FTDI…).
- **Linux only:** a udev rule is needed for the CP210x string-rewrite feature — see [DEPLOY.md](DEPLOY.md).

A Docker image and Docker Swarm deployment are also provided — see [DEPLOY.md](DEPLOY.md).

---

## Getting Started

```bash
git clone https://github.com/react-iot/workbench.git
cd workbench

# First run compiles the native npm modules, then starts the server.
deno task start
```

Open **http://localhost:4000**. Plugged-in serial ports appear in the sidebar automatically; click one to open a console, then hit **Discover** to read the chip.

Common tasks:

```bash
deno task dev          # start with --watch (auto-reload on change)
deno task dev:css      # rebuild the CSS bundle on change
deno task build:css    # one-off CSS build
deno test -A bin/ flash_helper/tests/   # run tests
```

Configuration is via environment variables (a `.env` file is loaded automatically — see [.env.example](.env.example)):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP/UI port |
| `RFC2217_HOST` | `0.0.0.0` | Interface the RFC2217 bridges bind to |
| `MDNS_DISABLED` | — | `1` to disable mDNS advertisements |
| `APP_VERSION` | *(deno.json `version`)* | Override the displayed version |
| `MCP_TOKEN` | — | Bearer token for the MCP endpoint (open if unset) |

---

## Connecting via Network Serial (ESP-IDF / esptool)

Every serial port the workbench sees is bridged to a TCP port using **RFC2217** (telnet com-port control), starting at **`:4001`**. The port number is shown on each device card in the sidebar (e.g. `tcp :4001`), and advertised over mDNS as `_rfc2217._tcp`.

Because `esptool` and ESP-IDF use [pySerial](https://pyserial.readthedocs.io), they can open these bridges directly with an `rfc2217://` URL — letting a build machine flash or monitor a board that's physically on a different host:

```bash
# Monitor a board over the network
esptool --port rfc2217://workbench.local:4001 chip_id

# Flash from an ESP-IDF project
idf.py -p 'rfc2217://workbench.local:4001' flash monitor
```

The DTR/RTS lines are forwarded, and the workbench intercepts `esptool`'s classic auto-reset sequence so the board can enter the download bootloader over the network.

### ⚠️ Gotchas

- **Network serial is speed-limited.** RFC2217 tunnels every byte over TCP, so throughput and latency are worse than local USB. `115200` is a safe default for the console/monitor.
- **Firmware upload is capped at 230400 baud over the network bridge.** That's the ceiling for flashing via the RFC2217 tunnel — set `esptool`/`idf.py` no higher (`-b 230400`); requesting a faster rate won't stick. At that rate, uploading a large app image over TCP takes minutes and can time out on a busy or high-latency link. **Flash large images locally over USB** where you can, and use the network bridge mainly for monitoring, discovery, and small operations.
- **A port has one owner at a time.** If the web console is attached to a port, an external `esptool` connection to the same RFC2217 bridge will contend with it. Close the console (or don't open it) before flashing from `esptool`.
- **Auto-reset into the bootloader can be flaky over the network.** If a board won't enter download mode from `esptool`, click **Flash Mode** in the workbench first to put it in the ROM bootloader manually, then run `esptool` with `--before no_reset`.
- **macOS CP210x reset quirk.** On macOS, changing DTR while RTS is asserted can glitch the reset line. The workbench handles this internally with an atomic line transition; if you script your own resets against the bridge, be aware the two lines must move together.
- **Baud changes take a moment to settle.** After an `esptool` baud switch, the underlying UART needs a brief window before it's stable — the bridge waits for the hardware before acknowledging, but extremely aggressive tools may still need a retry.

---

## License

[MIT](LICENSE) © Steven Miles / React IoT
