const LIST_SCRIPT = new URL("../bin/list-ports.js", import.meta.url).pathname;

interface RawPort {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  productName?: string;
  friendlyName?: string;
  pnpId?: string;
  locationId?: string;
}

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  productName?: string;
  pnpId?: string;
  locationId?: string;
  vendorName?: string;
  friendlyName: string;
  tcpPort?: number;
}

const VENDOR_NAMES: Record<string, string> = {
  "10c4": "Silicon Labs (CP210x)",
  "1a86": "QinHeng (CH340/CH9102)",
  "0403": "FTDI",
  "303a": "Espressif",
  "239a": "Adafruit",
  "2341": "Arduino",
};

function makeFriendlyName(p: RawPort): string {
  const vid = p.vendorId?.toLowerCase();
  const vendor = vid && VENDOR_NAMES[vid] ? VENDOR_NAMES[vid] : p.manufacturer;
  const base = p.path.split("/").pop() ?? p.path;
  return vendor ? `${base} — ${vendor}` : base;
}

const EXCLUDE_PATH_PATTERNS = [
  /debug-console/i,
  /bluetooth/i,
  /bt\b/i,
  /wireless/i,
];

function shouldExclude(p: RawPort): boolean {
  if (EXCLUDE_PATH_PATTERNS.some((re) => re.test(p.path))) return true;
  if (p.manufacturer && /bluetooth/i.test(p.manufacturer)) return true;
  if (!p.vendorId) return true;
  return false;
}

function normalizePath(path: string): string {
  if (Deno.build.os === "darwin" && path.startsWith("/dev/tty.")) {
    return path.replace("/dev/tty.", "/dev/cu.");
  }
  return path;
}

async function runNode(script: string, args: string[] = []): Promise<string> {
  const cmd = new Deno.Command("node", {
    args: [script, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  if (!success) {
    throw new Error(`${script} failed: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout);
}

export async function listPorts(): Promise<PortInfo[]> {
  const json = await runNode(LIST_SCRIPT);
  const raw: RawPort[] = JSON.parse(json);
  const showAll = Deno.env.get("SHOW_ALL_PORTS") === "1";
  return raw
    .filter((p) => showAll || !shouldExclude(p))
    .map((p) => {
      const path = normalizePath(p.path);
      const vid = p.vendorId?.toLowerCase();
      return {
        path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId,
        productName: p.productName,
        pnpId: p.pnpId,
        locationId: p.locationId,
        vendorName: vid ? VENDOR_NAMES[vid] : undefined,
        friendlyName: makeFriendlyName({ ...p, path }),
      };
    });
}

export type PortChangeListener = (ports: PortInfo[]) => void;

export class PortWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private last: string = "";
  private listeners = new Set<PortChangeListener>();

  start(intervalMs = 1500) {
    if (this.timer !== undefined) return;
    const tick = async () => {
      try {
        const ports = await listPorts();
        const sig = ports.map((p) => p.path).sort().join("|");
        if (sig !== this.last) {
          this.last = sig;
          for (const l of this.listeners) l(ports);
        }
      } catch (err) {
        console.error("PortWatcher tick failed:", err);
      }
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  subscribe(fn: PortChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
