import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createIngress, startIngress } from "./native-ingress.mjs";
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const exchange = (port) =>
  new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () => c.end("encrypted-fixture"));
    let bytes = "";
    c.on("data", (x) => (bytes += x));
    c.on("end", () => resolve(bytes));
    c.on("error", reject);
  });
test("encrypted stream is unchanged and unavailable local backend falls back to vendor route", async (t) => {
  const echo = net.createServer((c) => c.pipe(c));
  const target = await listen(echo);
  t.after(() => close(echo));
  const direct = createIngress({
    backendPort: target,
    fallback: () => {
      throw Error("unexpected fallback");
    },
  });
  const first = await listen(direct);
  t.after(() => close(direct));
  assert.equal(await exchange(first), "encrypted-fixture");
  const reserve = net.createServer();
  const unused = await listen(reserve);
  await close(reserve);
  let used = false;
  const fallback = createIngress({
    backendPort: unused,
    publicPort: target,
    fallback: async () => {
      used = true;
      return "127.0.0.1";
    },
  });
  const second = await listen(fallback);
  t.after(() => close(fallback));
  assert.equal(await exchange(second), "encrypted-fixture");
  assert.equal(used, true);
});
test("native ingress listeners are restricted to IPv4 and IPv6 loopback", async () => {
  const reserve = net.createServer();
  const port = await listen(reserve);
  await close(reserve);
  const servers = await startIngress({ port });
  assert.deepEqual(
    servers.map((s) => s.address().address),
    ["127.0.0.1", "::1"]
  );
  await Promise.all(servers.map(close));
});
