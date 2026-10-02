import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createIngress, startIngress, inspectClientHello } from "./native-ingress.mjs";
const word = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
function clientHello(host) {
  const hostname = Buffer.from(host);
  const name = Buffer.concat([Buffer.from([0]), word(hostname.length), hostname]);
  const names = Buffer.concat([word(name.length), name]);
  const sni = Buffer.concat([word(0), word(names.length), names]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    word(2),
    Buffer.from([0x13, 1, 1, 0]),
    word(sni.length),
    sni,
  ]);
  const header = Buffer.alloc(4);
  header[0] = 1;
  header.writeUIntBE(body.length, 1, 3);
  const handshake = Buffer.concat([header, body]);
  return Buffer.concat([Buffer.from([22, 3, 1]), word(handshake.length), handshake]);
}
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const exchange = (port, payload, fragmented = false) =>
  new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () => {
      if (fragmented) {
        c.write(payload.subarray(0, 7));
        setTimeout(() => c.end(payload.subarray(7)), 5);
      } else c.end(payload);
    });
    const bytes = [];
    c.on("data", (x) => bytes.push(x));
    c.on("end", () => resolve(Buffer.concat(bytes)));
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
  const packet = clientHello("api.anthropic.com");
  assert.deepEqual(await exchange(first, packet), packet);
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
  assert.deepEqual(await exchange(second, packet), packet);
  assert.equal(used, true);
});
test("other local TLS hostnames never enter the Claude backend or vendor fallback", async (t) => {
  let apiRequests = 0;
  const api = net.createServer((c) => {
    apiRequests++;
    c.destroy();
  });
  const local = net.createServer((c) => c.pipe(c));
  const apiPort = await listen(api),
    localPort = await listen(local);
  t.after(() => close(api));
  t.after(() => close(local));
  const ingress = createIngress({
    backendPort: apiPort,
    localRouterHost: "127.0.0.1",
    localRouterPort: localPort,
    fallback: () => {
      throw Error("other host reached vendor fallback");
    },
  });
  const port = await listen(ingress);
  t.after(() => close(ingress));
  for (const packet of [
    clientHello("sagrilo-photography.local"),
    Buffer.from("non-TLS-local-traffic"),
  ]) {
    assert.deepEqual(await exchange(port, packet), packet);
  }
  assert.equal(apiRequests, 0);
});
test("fragmented ClientHello and a large encrypted stream retain every byte", async (t) => {
  const packet = clientHello("api.anthropic.com");
  assert.equal(inspectClientHello(packet.subarray(0, 7)), undefined);
  assert.equal(inspectClientHello(packet), "api.anthropic.com");
  const hello = packet.subarray(5),
    cut = 20;
  const records = Buffer.concat([
    Buffer.from([22, 3, 1]),
    word(cut),
    hello.subarray(0, cut),
    Buffer.from([22, 3, 1]),
    word(hello.length - cut),
    hello.subarray(cut),
  ]);
  assert.equal(inspectClientHello(records), "api.anthropic.com");
  const payload = Buffer.concat([records, Buffer.alloc(1024 * 1024, 91)]);
  const echo = net.createServer((c) => c.pipe(c));
  const target = await listen(echo);
  t.after(() => close(echo));
  const ingress = createIngress({ backendPort: target });
  const port = await listen(ingress);
  t.after(() => close(ingress));
  assert.deepEqual(await exchange(port, payload, true), payload);
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
test(
  "macOS wildcard Local listener coexists and receives other loopback HTTPS names",
  { skip: process.platform !== "darwin" },
  async (t) => {
    let localRequests = 0;
    const local = net.createServer((c) => {
      localRequests++;
      c.pipe(c);
    });
    const port = await new Promise((resolve, reject) => {
      local.once("error", reject);
      local.listen(0, "0.0.0.0", () => resolve(local.address().port));
    });
    t.after(() => close(local));
    const ingress = createIngress({ localRouterPort: port });
    await new Promise((resolve, reject) => {
      ingress.once("error", reject);
      ingress.listen(port, "127.0.0.1", resolve);
    });
    t.after(() => close(ingress));
    const packet = clientHello("another-project.local");
    assert.deepEqual(await exchange(port, packet), packet);
    assert.equal(localRequests, 1);
  }
);
