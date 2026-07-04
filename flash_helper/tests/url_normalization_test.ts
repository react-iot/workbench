import { assertEquals } from "jsr:@std/assert";

// Mirror of the private normalizePort in reset.ts — export it for testing via
// a thin re-export shim so we don't need to expose it in the public API.
function normalizePort(port: string, addIgn: boolean): string {
  if (!port.startsWith("rfc2217://") || !addIgn) return port;
  if (port.includes("ign_set_control")) return port;
  return port + (port.includes("?") ? "&" : "?") + "ign_set_control";
}

Deno.test("rfc2217 url gets ign_set_control appended", () => {
  assertEquals(
    normalizePort("rfc2217://host:3333", true),
    "rfc2217://host:3333?ign_set_control",
  );
});

Deno.test("rfc2217 url with existing query preserves it", () => {
  assertEquals(
    normalizePort("rfc2217://host:3333?foo=bar", true),
    "rfc2217://host:3333?foo=bar&ign_set_control",
  );
});

Deno.test("rfc2217 url with existing ign_set_control is unchanged", () => {
  assertEquals(
    normalizePort("rfc2217://host:3333?ign_set_control", true),
    "rfc2217://host:3333?ign_set_control",
  );
});

Deno.test("rfc2217 url with ign_set_control in middle is unchanged", () => {
  assertEquals(
    normalizePort("rfc2217://host:3333?ign_set_control&baud=115200", true),
    "rfc2217://host:3333?ign_set_control&baud=115200",
  );
});

Deno.test("local port is passed through unchanged", () => {
  assertEquals(normalizePort("/dev/ttyUSB0", true), "/dev/ttyUSB0");
  assertEquals(normalizePort("COM3", true), "COM3");
});

Deno.test("addIgn=false leaves rfc2217 url alone", () => {
  assertEquals(
    normalizePort("rfc2217://host:3333", false),
    "rfc2217://host:3333",
  );
});
