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

/** Forward encrypted bytes only; no certificate, token or HTTP parsing occurs here. */
export function createIngress({
  backendPort = 8443,
  fallback = publicAnthropicAddress,
  publicPort = 443,
} = {}) {
  return net.createServer({ allowHalfOpen: true }, (client) => {
    client.pause();
    let upstream;
    let closed = false;
    const drop = () => {
      closed = true;
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
        upstream.on("close", () => client.destroy());
        client.pipe(upstream).pipe(client);
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
    connect("127.0.0.1", backendPort, true);
  });
}

export async function startIngress({ port = 443, backendPort = 8443 } = {}) {
  const servers = [];
  try {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createIngress({ backendPort });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port, ipv6Only: host === "::1" }, resolve);
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
  const listeners = await startIngress();
  if (process.getuid?.() === 0) {
    process.setgid("nobody");
    process.setuid("nobody");
  }
  console.log(
    "Native ingress: 127.0.0.1/[::1]:443 -> 127.0.0.1:8443; encrypted passthrough; direct vendor fallback if listener is unavailable."
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      for (const listener of listeners) listener.close();
      setTimeout(() => process.exit(0), 1000).unref();
    });
}
