import { assertEquals, assertRejects } from "jsr:@std/assert";
import { _setBackendFactory } from "../serial/index.ts";
import { verify } from "../reset.ts";
import type { SerialBackend } from "../serial/index.ts";

class SilentSerial implements SerialBackend {
  async open() {}
  async close() {}
  async setDtrRts(_dtr: boolean, _rts: boolean) {}
  async write(_bytes: Uint8Array) {}
  async read(_maxBytes: number, _timeoutMs: number) { return new Uint8Array(0); }
  async flushInput() {}
}

class ReplyingSerial extends SilentSerial {
  // Realistic SLIP-framed bootloader response starts with 0xC0 and ends with 0xC0
  private readonly reply = new Uint8Array([0xc0, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0]);
  override async read(_maxBytes: number, _timeoutMs: number) { return this.reply; }
}

class ErrorOnOpenSerial extends SilentSerial {
  override async open() { throw new Error("ENOENT: port not found"); }
}

function withMock(factory: () => SerialBackend, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    _setBackendFactory(() => factory());
    try {
      await fn();
    } finally {
      _setBackendFactory(null);
    }
  };
}

Deno.test(
  "serial open error propagates not swallowed",
  withMock(() => new ErrorOnOpenSerial(), async () => {
    await assertRejects(
      () => verify("/dev/ttyUSB0"),
      Error,
      "ENOENT",
    );
  }),
);

Deno.test(
  "verify returns false on silent port",
  withMock(() => new SilentSerial(), async () => {
    const result = await verify("/dev/ttyUSB0");
    assertEquals(result, false);
  }),
);

Deno.test(
  "verify returns true on SLIP reply",
  withMock(() => new ReplyingSerial(), async () => {
    const result = await verify("/dev/ttyUSB0");
    assertEquals(result, true);
  }),
);
