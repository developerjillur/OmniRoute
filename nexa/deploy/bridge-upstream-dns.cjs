"use strict";
// Keep this process's Anthropic provider connection on public DNS while local
// clients use the Agent Bridge hosts entry. TLS verification stays enabled.
const dns = require("node:dns");
const originalLookup = dns.lookup.bind(dns);
const resolver = new dns.Resolver();
resolver.setServers(["8.8.8.8", "1.1.1.1"]);
dns.lookup = function bridgeUpstreamLookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  if (String(hostname).toLowerCase() !== "api.anthropic.com") {
    return originalLookup(hostname, options, callback);
  }
  const config = typeof options === "number" ? { family: options } : (options || {});
  const family = config.family === 6 ? 6 : 4;
  const resolve = family === 6 ? resolver.resolve6.bind(resolver) : resolver.resolve4.bind(resolver);
  resolve(hostname, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length) return callback(Object.assign(new Error("No public Anthropic address"), { code: "ENOTFOUND" }));
    if (config.all) return callback(null, addresses.map(address => ({ address, family })));
    callback(null, addresses[0], family);
  });
};
