# Deploy to Docker Swarm

This service pins to one worker because it owns the USB hub with the ESP32
boards. Single replica, host networking, `/dev` bind-mount for device access.

## 1. Label the worker

On any manager node, label the worker that has the boards physically
attached:

```bash
docker node update --label-add esp32_gateway=true <worker-hostname>
```

Verify:

```bash
docker node inspect <worker-hostname> --format '{{ .Spec.Labels }}'
```

## 2. Host-side udev rule (only needed for CP210x serial rewrite)

Without this rule the Write-USB-serial button will fail with a permission
error when libusb tries to claim the device:

```bash
sudo tee /etc/udev/rules.d/99-cp210x.rules <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", MODE="0666"
EOF
sudo udevadm control --reload
sudo udevadm trigger
```

## 3. Build the image (on the worker or pushed from elsewhere)

### Single-node swarm (build locally on the worker)

```bash
docker build -t esp32-workbench:latest .
```

### Multi-node swarm (build + push to a registry)

```bash
# Run a local registry once, on a manager:
docker service create --name registry --publish 5000:5000 registry:2

# On the build host (arm64 for RPi, use buildx if cross-building):
docker build -t <registry-host>:5000/esp32-workbench:latest .
docker push <registry-host>:5000/esp32-workbench:latest

# Update the image: line in docker-compose.yml to <registry-host>:5000/esp32-workbench:latest
```

## 4. Deploy

```bash
docker stack deploy -c docker-compose.yml workbench
```

## 5. Verify

```bash
docker stack services workbench
docker service logs -f workbench_esp32-workbench
docker service ps workbench_esp32-workbench
```

The UI is at `http://<worker-hostname>:4000/`. mDNS also advertises
`_esp32-workbench._tcp` so it'll appear in Bonjour/Avahi browsers on the LAN.

## MCP endpoint (for AI agents)

An MCP interface is served at `POST http://<worker-hostname>:4000/mcp`
(Streamable HTTP). Tools: `list_ports`, `list_sessions`, `detect_chip`,
`discover_device`, `reset_device`, `enter_bootloader`, `read_console`. Point
Claude / MCP Inspector at that URL.

`read_console` captures live serial output for a bounded window (`duration_ms`,
or until an `until` substring). If the client sends a `progressToken` the
output streams incrementally over SSE (`text/event-stream`); otherwise the
collected text is returned as one JSON result.

**Security — read before exposing.** Configure via env (see `.env.example`):

- `MCP_TOKEN` — optional bearer. **Unset = the endpoint is open to anyone who
  can reach the port.** Fine on a trusted LAN; set a long random value
  otherwise. Clients then send `Authorization: Bearer <token>`.
- `MCP_DISABLED=1` — turn the endpoint off.
- `MCP_ALLOWED_ORIGINS` — only needed for browser-based MCP clients; non-browser
  clients send no `Origin` and are allowed. A browser `Origin` is rejected
  unless listed (DNS-rebinding guard).

Device tools refuse a port that already has an open console unless called with
`force: true`. Firmware flashing is intentionally **not** exposed.

### Connecting Claude Code

Run these on a machine that can reach the server on the LAN (`localhost` if it's
the same box, else the worker hostname/IP). Replace `<host>` and the token.

Open endpoint (no `MCP_TOKEN` set):

```bash
claude mcp add --transport http esp32-workbench http://<host>:4000/mcp
```

With a bearer token:

```bash
claude mcp add --transport http esp32-workbench http://<host>:4000/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

Add `--scope user` to make it available in every project (default is this
project only). Verify and manage:

```bash
claude mcp list                 # shows connection status
claude mcp get esp32-workbench
claude mcp remove esp32-workbench
```

Then in a session, `/mcp` lists the server and its tools. Ask e.g. *"list the
serial ports"* or *"discover the device on /dev/ttyUSB0"*.

To share with a project via a committed `.mcp.json` instead of the CLI:

```json
{
  "mcpServers": {
    "esp32-workbench": {
      "type": "http",
      "url": "http://<host>:4000/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

### Connecting Claude Desktop

Claude Desktop has no native HTTP-MCP transport in its config file — bridge to
it with `mcp-remote` (needs Node/`npx` installed). Its built-in custom-connector
UI is OAuth-oriented, so the bridge is the route for a static bearer token.

Edit `claude_desktop_config.json`:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Open endpoint (no token):

```json
{
  "mcpServers": {
    "esp32-workbench": {
      "command": "npx",
      "args": ["mcp-remote", "http://<host>:4000/mcp"]
    }
  }
}
```

With a bearer token — note the header has **no space around the colon** in
`args`; the space lives in the env var. This dodges a Claude Desktop/Windows bug
that mangles spaces inside `args`:

```json
{
  "mcpServers": {
    "esp32-workbench": {
      "command": "npx",
      "args": ["mcp-remote", "http://<host>:4000/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Fully quit and reopen Claude Desktop after editing. The server and its tools then
appear under the tools/connector menu.

**`http://` caveat:** `mcp-remote` treats plain-HTTP remotes as insecure. If
Desktop runs on the **same box** as the server, use `http://localhost:4000/mcp`
— localhost HTTP is fine. Reaching another LAN host over plain HTTP may be
blocked; put a TLS reverse proxy in front (or run Desktop on the server box).

**claude.ai (web) won't work** either way — the cloud can't reach a LAN address.

## Updating

Pull or rebuild the image, then:

```bash
docker service update --image esp32-workbench:latest --force workbench_esp32-workbench
```

The `update_config.order: stop-first` in the compose means the old container
releases the USB device before the new one spins up — important because two
containers can't share a serial port.

## Troubleshooting

- **"Service name is already in use" on startup** — the host runs its own
  mDNS (avahi/bonjour). Either stop it, or set `MDNS_DISABLED: "1"` in the
  compose file's `environment` block.
- **`/dev/ttyUSB*` not showing up in the UI** — the bind-mount is
  _one-shot at container start_ by default. With `/dev` bind-mounted the
  container sees live device changes because Linux's devtmpfs is shared.
  If you hotplug while the container is running and nothing appears, check
  `docker exec workbench ls /dev/ttyUSB*` on the worker — if the host sees
  it and the container doesn't, restart the service.
- **CP210x write fails with `LIBUSB_ERROR_ACCESS`** — the udev rule isn't
  in effect. Verify with `ls -l /dev/bus/usb/*/*` (should have `0666` mode
  for the CP210x), and retrigger udev.
- **Wrong node got scheduled** — `docker service ps workbench_esp32-workbench`
  shows "no suitable node" if your label is missing or the typo'd key
  doesn't match the constraint.
