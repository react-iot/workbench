import { assertEquals } from "jsr:@std/assert";
import { Buffer } from "node:buffer";
import * as net from "node:net";
import { Rfc2217Serial } from "../serial/rfc2217.ts";

// Stand up a local TCP server that records received bytes and can inject data.
interface MockServer {
  port: number;
  received: number[];
  inject(bytes: number[]): void;
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const received: number[] = [];
  let clientSock: net.Socket | null = null;

  const server = net.createServer((sock) => {
    clientSock = sock;
    sock.on("data", (buf: Buffer) => {
      for (const b of buf) received.push(b);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    received,
    inject(bytes: number[]) {
      clientSock?.write(Buffer.from(bytes));
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        clientSock?.destroy();
        server.close(() => resolve());
      });
    },
  };
}

async function makeSerial(port: number): Promise<Rfc2217Serial> {
  const s = new Rfc2217Serial(`rfc2217://127.0.0.1:${port}`, 115200);
  await s.open();
  return s;
}

Deno.test("open sends IAC DO COM-PORT-OPTION", async () => {
  const srv = await startMockServer();
  const serial = await makeSerial(srv.port);
  await new Promise((r) => setTimeout(r, 50));
  await serial.close();
  await srv.close();

  // First 3 bytes should be FF FD 2C (IAC DO COM_PORT_OPTION)
  assertEquals(srv.received.slice(0, 3), [0xff, 0xfd, 0x2c]);
});

Deno.test("setDtrRts(true, false) emits DTR_ON then RTS_OFF subnegs", async () => {
  const srv = await startMockServer();
  const serial = await makeSerial(srv.port);
  srv.received.length = 0; // clear negotiation bytes
  await serial.setDtrRts(true, false);
  await serial.close();
  await srv.close();

  // DTR_ON subneg: FF FA 2C 05 08 FF F0
  const dtrOn  = [0xff, 0xfa, 0x2c, 0x05, 0x08, 0xff, 0xf0];
  // RTS_OFF subneg: FF FA 2C 05 0C FF F0
  const rtsOff = [0xff, 0xfa, 0x2c, 0x05, 0x0c, 0xff, 0xf0];
  assertEquals(srv.received.slice(0, 7),  dtrOn);
  assertEquals(srv.received.slice(7, 14), rtsOff);
});

Deno.test("setDtrRts(false, true) emits DTR_OFF then RTS_ON subnegs", async () => {
  const srv = await startMockServer();
  const serial = await makeSerial(srv.port);
  srv.received.length = 0;
  await serial.setDtrRts(false, true);
  await serial.close();
  await srv.close();

  const dtrOff = [0xff, 0xfa, 0x2c, 0x05, 0x09, 0xff, 0xf0];
  const rtsOn  = [0xff, 0xfa, 0x2c, 0x05, 0x0b, 0xff, 0xf0];
  assertEquals(srv.received.slice(0, 7),  dtrOff);
  assertEquals(srv.received.slice(7, 14), rtsOn);
});

Deno.test("data bytes with 0xFF are IAC-escaped on write", async () => {
  const srv = await startMockServer();
  const serial = await makeSerial(srv.port);
  srv.received.length = 0;
  await serial.write(new Uint8Array([0xff, 0x42]));
  await new Promise((r) => setTimeout(r, 20));
  await serial.close();
  await srv.close();

  // 0xFF must be doubled; 0x42 passes through
  assertEquals(srv.received, [0xff, 0xff, 0x42]);
});

Deno.test("inbound IAC IAC becomes single 0xFF in read buffer", async () => {
  const srv = await startMockServer();
  const serial = await makeSerial(srv.port);
  await new Promise((r) => setTimeout(r, 50));
  await serial.flushInput();
  srv.inject([0xff, 0xff, 0x41]); // escaped IAC then 'A'
  await new Promise((r) => setTimeout(r, 30));
  const data = await serial.read(4, 50);
  await serial.close();
  await srv.close();

  assertEquals(Array.from(data), [0xff, 0x41]);
});

Deno.test("inbound subneg IAC SB...IAC SE is stripped from read buffer", async () => {
  const srv = await startMockServer();
  const serial = await makeSerial(srv.port);
  await new Promise((r) => setTimeout(r, 50));
  await serial.flushInput();
  // Inject: plain 'A', subneg (stripped), plain 'B'
  srv.inject([0x41, 0xff, 0xfa, 0x2c, 0x65, 0x00, 0xff, 0xf0, 0x42]);
  await new Promise((r) => setTimeout(r, 30));
  const data = await serial.read(4, 50);
  await serial.close();
  await srv.close();

  assertEquals(Array.from(data), [0x41, 0x42]);
});

Deno.test("inbound 2-byte WILL/WONT is stripped from read buffer", async () => {
  const srv = await startMockServer();
  const serial = await makeSerial(srv.port);
  await new Promise((r) => setTimeout(r, 50));
  await serial.flushInput();
  // 'A', WILL COM_PORT_OPTION (3 bytes), 'B'
  srv.inject([0x41, 0xff, 0xfb, 0x2c, 0x42]);
  await new Promise((r) => setTimeout(r, 30));
  const data = await serial.read(4, 50);
  await serial.close();
  await srv.close();

  assertEquals(Array.from(data), [0x41, 0x42]);
});
