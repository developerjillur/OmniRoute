import test from "node:test";
import assert from "node:assert/strict";
import { verifyClientDns } from "./bridge-gate.mjs";

test("Bridge acceptance rejects cached public DNS even when hosts entries and explicit TLS probes pass", async () => {
  for (const addresses of [
    [],
    [{ address: "160.79.104.10", family: 4 }],
    [
      { address: "127.0.0.1", family: 4 },
      { address: "2607:6bc0::10", family: 6 },
    ],
  ])
    await assert.rejects(
      verifyClientDns(async () => addresses),
      /Native client DNS bypasses/
    );
});
test("Bridge acceptance permits IPv4 and IPv6 native loopback resolution", async () => {
  assert.deepEqual(
    await verifyClientDns(async (host, options) => {
      assert.equal(host, "api.anthropic.com");
      assert.equal(options.all, true);
      return [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ];
    }),
    { clientDnsVerified: true }
  );
});
