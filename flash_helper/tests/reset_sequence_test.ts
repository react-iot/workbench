import { assertEquals, assertGreaterOrEqual } from "jsr:@std/assert";
import { _setBackendFactory } from "../serial/index.ts";
import { enterBootloader, hardReset } from "../reset.ts";
import type { SerialBackend } from "../serial/index.ts";

interface Call {
  dtr: boolean;
  rts: boolean;
  t: number;
}

class MockSerial implements SerialBackend {
  readonly calls: Call[] = [];
  async open() {}
  async close() {}
  async setDtrRts(dtr: boolean, rts: boolean) {
    this.calls.push({ dtr, rts, t: performance.now() });
  }
  async write(_: Uint8Array) {}
  async read(_maxBytes: number, _timeoutMs: number) { return new Uint8Array(0); }
  async flushInput() {}
}

function withMock(fn: (mock: MockSerial) => Promise<void>): () => Promise<void> {
  return async () => {
    const mock = new MockSerial();
    _setBackendFactory(() => mock);
    try {
      await fn(mock);
    } finally {
      _setBackendFactory(null);
    }
  };
}

Deno.test("enterBootloader emits exactly three transitions", withMock(async (mock) => {
  await enterBootloader("/dev/ttyUSB0");
  assertEquals(mock.calls.length, 3);
  assertEquals(mock.calls[0], { dtr: false, rts: true,  t: mock.calls[0].t }); // EN low
  assertEquals(mock.calls[1], { dtr: true,  rts: false, t: mock.calls[1].t }); // EN high, GPIO0 low
  assertEquals(mock.calls[2], { dtr: false, rts: false, t: mock.calls[2].t }); // release
}));

Deno.test("enterBootloader sleeps at least resetHoldMs between transitions 1 and 2", withMock(async (mock) => {
  const HOLD = 150;
  await enterBootloader("/dev/ttyUSB0", { resetHoldMs: HOLD, gpio0HoldMs: 10 });
  const dt = mock.calls[1].t - mock.calls[0].t;
  assertGreaterOrEqual(dt, HOLD - 5); // 5 ms tolerance for scheduler jitter
}));

Deno.test("enterBootloader sleeps at least gpio0HoldMs between transitions 2 and 3", withMock(async (mock) => {
  const HOLD = 120;
  await enterBootloader("/dev/ttyUSB0", { resetHoldMs: 10, gpio0HoldMs: HOLD });
  const dt = mock.calls[2].t - mock.calls[1].t;
  assertGreaterOrEqual(dt, HOLD - 5);
}));

Deno.test("hardReset emits exactly two transitions", withMock(async (mock) => {
  await hardReset("/dev/ttyUSB0");
  assertEquals(mock.calls.length, 2);
  assertEquals(mock.calls[0].dtr, false);
  assertEquals(mock.calls[0].rts, true);
  assertEquals(mock.calls[1].dtr, false); // DTR never true
  assertEquals(mock.calls[1].rts, false);
}));

Deno.test("hardReset never asserts DTR", withMock(async (mock) => {
  await hardReset("/dev/ttyUSB0", { resetHoldMs: 20 });
  for (const c of mock.calls) {
    assertEquals(c.dtr, false, "DTR must never be true in hardReset");
  }
}));

Deno.test("custom timings are respected", withMock(async (mock) => {
  await enterBootloader("/dev/ttyUSB0", { resetHoldMs: 200, gpio0HoldMs: 150 });
  const dt01 = mock.calls[1].t - mock.calls[0].t;
  const dt12 = mock.calls[2].t - mock.calls[1].t;
  assertGreaterOrEqual(dt01, 195);
  assertGreaterOrEqual(dt12, 145);
}));

Deno.test("env vars override defaults", withMock(async (mock) => {
  Deno.env.set("FLASH_HELPER_RESET_HOLD_MS", "250");
  Deno.env.set("FLASH_HELPER_GPIO0_HOLD_MS", "10");
  try {
    await enterBootloader("/dev/ttyUSB0");
    const dt = mock.calls[1].t - mock.calls[0].t;
    assertGreaterOrEqual(dt, 245);
  } finally {
    Deno.env.delete("FLASH_HELPER_RESET_HOLD_MS");
    Deno.env.delete("FLASH_HELPER_GPIO0_HOLD_MS");
  }
}));
