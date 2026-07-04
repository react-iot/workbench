import { assertEquals } from "jsr:@std/assert";
import { makeMcpHandler } from "./mcp.ts";

const deps = {
  portsWithRfc: () => Promise.resolve([{ path: "/dev/ttyUSB0", tcpPort: 5000 }]),
  nvsToJson: (x: unknown) => x,
};
const rpc = (id: unknown, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:4000/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

Deno.test("initialize returns serverInfo (open, no token)", async () => {
  const h = makeMcpHandler(deps);
  const res = await h(post(rpc(1, "initialize")));
  assertEquals(res.status, 200);
  const j = await res.json();
  assertEquals(j.result.serverInfo.name, "ESP32 Workbench");
  assertEquals(typeof j.result.protocolVersion, "string");
});

Deno.test("wrong token -> 401, right token -> ok", async () => {
  const h = makeMcpHandler({ ...deps, token: "secret" });
  assertEquals((await h(post(rpc(1, "initialize"), { authorization: "Bearer nope" }))).status, 401);
  assertEquals((await h(post(rpc(1, "initialize")))).status, 401); // missing header
  assertEquals((await h(post(rpc(1, "initialize"), { authorization: "Bearer secret" }))).status, 200);
});

Deno.test("browser Origin rejected unless allowlisted", async () => {
  const h = makeMcpHandler(deps);
  assertEquals((await h(post(rpc(1, "initialize"), { origin: "http://evil.example" }))).status, 403);
  const h2 = makeMcpHandler({ ...deps, allowedOrigins: ["http://ok.example"] });
  assertEquals((await h2(post(rpc(1, "initialize"), { origin: "http://ok.example" }))).status, 200);
});

Deno.test("notification (no id) -> 202", async () => {
  const h = makeMcpHandler(deps);
  const res = await h(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assertEquals(res.status, 202);
});

Deno.test("tools/list exposes the read tools", async () => {
  const h = makeMcpHandler(deps);
  const j = await (await h(post(rpc(1, "tools/list")))).json();
  const names = j.result.tools.map((t: { name: string }) => t.name);
  for (const n of ["list_ports", "list_sessions", "discover_device", "detect_chip", "reset_device", "enter_bootloader", "read_console"]) {
    assertEquals(names.includes(n), true, `missing tool ${n}`);
  }
});

Deno.test("tools/call list_ports returns the port list", async () => {
  const h = makeMcpHandler(deps);
  const j = await (await h(post(rpc(1, "tools/call", { name: "list_ports" }))).then((r) => r.json()));
  const parsed = JSON.parse(j.result.content[0].text);
  assertEquals(parsed[0].path, "/dev/ttyUSB0");
});

Deno.test("unknown method -> -32601, GET -> 405", async () => {
  const h = makeMcpHandler(deps);
  const j = await (await h(post(rpc(1, "bogus/method")))).json();
  assertEquals(j.error.code, -32601);
  const get = await h(new Request("http://localhost:4000/mcp", { method: "GET" }));
  assertEquals(get.status, 405);
});
