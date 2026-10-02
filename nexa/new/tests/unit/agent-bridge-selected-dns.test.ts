import test from "node:test";
import assert from "node:assert/strict";
import { provisionDnsEntries } from "../../src/mitm/dns/provision.ts";

test("selected-only DNS provisions enabled agents without adding Antigravity defaults", async () => {
  const before = process.env.MITM_SELECTED_ONLY;
  process.env.MITM_SELECTED_ONLY = "true";
  const calls: string[][] = [];
  try {
    await provisionDnsEntries("synthetic", {
      canElevate: () => true,
      addDefaultDns: async () => {
        assert.fail("Unselected defaults must not be added");
      },
      addHostsDns: async (hosts) => {
        calls.push(hosts);
      },
      getAgentStates: () => [{ agent_id: "claude-code", dns_enabled: true }] as never,
      listEnabledCustomHosts: () => [],
      logger: {
        info() {},
        error() {
          assert.fail("Provisioning must not fail");
        },
      },
    });
    assert.deepEqual(calls, [["api.anthropic.com"]]);
  } finally {
    if (before === undefined) delete process.env.MITM_SELECTED_ONLY;
    else process.env.MITM_SELECTED_ONLY = before;
  }
});
