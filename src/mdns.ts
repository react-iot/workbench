import { Bonjour, type Service } from "bonjour-service";

export interface RfcAssignment {
  path: string;
  tcpPort: number;
}

interface PublishedRfc {
  tcpPort: number;
  service: Service;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export class MdnsManager {
  private bonjour = new Bonjour();
  private rfcByPath = new Map<string, PublishedRfc>();
  private httpService?: Service;
  private workbenchService?: Service;

  publishStatic(httpPort: number): void {
    this.httpService = this.bonjour.publish({
      name: "ESP32 Workbench",
      type: "http",
      port: httpPort,
      probe: false,
      txt: { path: "/" },
    });
    this.workbenchService = this.bonjour.publish({
      name: "ESP32 Workbench",
      type: "esp32-workbench",
      port: httpPort,
      probe: false,
      txt: {
        api: "/api/ports",
        ws: "/ws/ports",
        version: "1",
      },
    });
  }

  syncRfc(assignments: RfcAssignment[]): void {
    const active = new Map(assignments.map((a) => [a.path, a.tcpPort]));

    for (const [path, pub] of this.rfcByPath) {
      const wanted = active.get(path);
      if (wanted === undefined || wanted !== pub.tcpPort) {
        pub.service.stop?.();
        this.rfcByPath.delete(path);
      }
    }

    for (const { path, tcpPort } of assignments) {
      if (this.rfcByPath.has(path)) continue;
      const service = this.bonjour.publish({
        name: basename(path),
        type: "rfc2217",
        port: tcpPort,
        probe: false,
        txt: { path },
      });
      this.rfcByPath.set(path, { tcpPort, service });
    }
  }

  async shutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.bonjour.unpublishAll(() => resolve());
    });
    this.bonjour.destroy();
    this.rfcByPath.clear();
    this.httpService = undefined;
    this.workbenchService = undefined;
  }
}
