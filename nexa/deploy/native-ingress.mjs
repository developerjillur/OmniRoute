import net from "node:net";
import { Resolver } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);
let cached,
  expires = 0;
async function publicAnthropicAddress() {
  if (cached && Date.now() < expires) return cached;
  const addresses = await resolver.resolve4("api.anthropic.com");
  cached = addresses.find((address) => net.isIP(address) === 4 && !address.startsWith("127."));
  if (!cached) throw new Error("No public Anthropic address");
  expires = Date.now() + 60_000;
  return cached;
}

/** Read only the public TLS ClientHello hostname; undefined means incomplete. */
export function inspectClientHello(bytes) {
  const fragments = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    if (bytes[offset] !== 22) return null;
    const size = bytes.readUInt16BE(offset + 3);
    if (offset + 5 + size > bytes.length) return undefined;
    fragments.push(bytes.subarray(offset + 5, offset + 5 + size));
    const hello = Buffer.concat(fragments);
    offset += 5 + size;
    if (hello.length < 4) continue;
    if (hello[0] !== 1) return null;
    const end = 4 + hello.readUIntBE(1, 3);
    if (end > 65536) return null;
    if (hello.length < end) continue;
    try {
      let i = 38; // handshake header, legacy version and random
      i += 1 + hello[i];
      i += 2 + hello.readUInt16BE(i);
      i += 1 + hello[i];
      if (i + 2 > end) return null;
      const extensionsEnd = i + 2 + hello.readUInt16BE(i);
      if (extensionsEnd !== end) return null;
      i += 2;
      while (i + 4 <= end) {
        const type = hello.readUInt16BE(i);
        const length = hello.readUInt16BE(i + 2);
        i += 4;
        if (i + length > end) return null;
        if (type === 0) {
          const listEnd = i + 2 + hello.readUInt16BE(i);
          if (listEnd !== i + length) return null;
          let name = i + 2;
          while (name + 3 <= listEnd) {
            const kind = hello[name];
            const size = hello.readUInt16BE(name + 1);
            name += 3;
            if (!size || name + size > listEnd) return null;
            if (kind === 0) {
              const host = hello.subarray(name, name + size);
              if (host.some((b) => b > 127)) return null;
              return host.toString("ascii").toLowerCase();
            }
            name += size;
          }
          return null;
        }
        i += length;
      }
      return null;
    } catch {
      return null;
    }
  }
  return undefined;
}

/** Forward untouched TLS bytes; no certificate, token or HTTP parsing occurs here. */
export function createIngress({
  backendPort = 8443,
  fallback = publicAnthropicAddress,
  publicPort = 443,
  localRouterHost = "127.0.0.2",
  localRouterPort = 443,
} = {}) {
  return net.createServer({ allowHalfOpen: true }, (client) => {
    let upstream;
    let closed = false;
    let pending = Buffer.alloc(0);
    let decided = false;
    let sniffTimer;
    const drop = () => {
      closed = true;
      clearTimeout(sniffTimer);
      client.destroy();
      upstream?.destroy();
    };
    client.on("error", drop);
    client.on("close", drop);
    const connect = (host, port, mayFallback) => {
      if (closed) return;
      upstream = net.connect({ host, port, allowHalfOpen: true });
      upstream.setTimeout(600_000, drop);
      const timer = setTimeout(() => upstream.destroy(new Error("Connect timeout")), 5_000);
      upstream.once("connect", () => {
        clearTimeout(timer);
        upstream.removeAllListeners("error");
        upstream.on("error", drop);
        upstream.on("close", () => client.end());
        upstream.write(pending);
        pending = Buffer.alloc(0);
        client.pipe(upstream).pipe(client);
        if (client.readableEnded) upstream.end();
        client.resume();
      });
      upstream.once("error", async () => {
        clearTimeout(timer);
        if (!mayFallback) return drop();
        try {
          connect(await fallback(), publicPort, false);
        } catch {
          drop();
        }
      });
    };
    const choose = (host) => {
      if (decided) return;
      decided = true;
      clearTimeout(sniffTimer);
      client.pause();
      client.removeListener("data", sniff);
      if (host === "api.anthropic.com") connect("127.0.0.1", backendPort, true);
      else connect(localRouterHost, localRouterPort, false);
    };
    const sniff = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const host = inspectClientHello(pending);
      if (host !== undefined) choose(host);
      else if (pending.length > 65536) drop();
    };
    sniffTimer = setTimeout(drop, 5000);
    client.on("data", sniff);
    client.on("end", () => {
      if (!decided) choose(null);
    });
  });
}

export function inheritedSocketFds(value) {
  if (!value) return [];
  const sockets = value.split(",");
  const seen = new Set();
  return sockets.map((socket) => {
    const match = /^(\d+)@(127\.0\.0\.1:443|\[::1\]:443)$/.exec(socket);
    const fd = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(fd) || fd < 3 || seen.has(fd))
      throw new Error("Invalid inherited loopback HTTPS socket");
    seen.add(fd);
    return fd;
  });
}

export async function startIngress({ port = 443, backendPort = 8443, fds = [] } = {}) {
  const servers = [];
  try {
    for (const endpoint of fds.length ? fds : ["127.0.0.1", "::1"]) {
      const server = createIngress({ backendPort });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          typeof endpoint === "number"
            ? { fd: endpoint }
            : { host: endpoint, port, ipv6Only: endpoint === "::1" },
          resolve
        );
      });
      servers.push(server);
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  return servers;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // User-owned inherited sockets coexist with Local's wildcard nginx listeners.
  const listeners = await startIngress({ fds: inheritedSocketFds(process.env.OMNI_LISTEN_FDS) });
  if (process.getuid?.() === 0) {
    process.setgid("nobody");
    process.setuid("nobody");
  }
  console.log(
    "Native ingress: loopback :443; api.anthropic.com -> :8443 with direct vendor fallback; other SNI -> Local router 127.0.0.2:443; untouched TLS."
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      for (const listener of listeners) listener.close();
      setTimeout(() => process.exit(0), 1000).unref();
    });
}
