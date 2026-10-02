import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readBridgeRuntimeStatus,
  readBridgeIntent,
  writeBridgeIntent,
  shouldRecoverBridge,
} from "../../src/mitm/runtimeState.ts";

test("status uses actual child counters and configured port, never stale active connections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
  const before = process.env.MITM_LOCAL_PORT;
  process.env.MITM_LOCAL_PORT = "8443";
  try {
    fs.writeFileSync(
      path.join(dir, "stats.json"),
      JSON.stringify({
        interceptedRequests: 17,
        totalRequests: 29,
        activeConnections: 2,
        startedAt: "2026-10-02T00:00:00Z",
      })
    );
    assert.deepEqual(readBridgeRuntimeStatus(dir, true), {
      port: 8443,
      interceptedCount: 17,
      totalRequests: 29,
      activeConns: 2,
      lastStartedAt: "2026-10-02T00:00:00Z",
    });
    assert.equal(readBridgeRuntimeStatus(dir, false).activeConns, 0);
    fs.writeFileSync(path.join(dir, "stats.json"), "invalid-json");
    assert.equal(readBridgeRuntimeStatus(dir, true).interceptedCount, 0);
  } finally {
    if (before === undefined) delete process.env.MITM_LOCAL_PORT;
    else process.env.MITM_LOCAL_PORT = before;
  }
});

test("explicit Stop persists across restarts; recovery is opt-in and requires enabled intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-intent-"));
  assert.equal(readBridgeIntent(dir), false);
  writeBridgeIntent(dir, true);
  assert.equal(
    shouldRecoverBridge({ MITM_AUTO_RECOVER: "true" }, readBridgeIntent(dir), false),
    true
  );
  assert.equal(shouldRecoverBridge({}, true, false), false);
  assert.equal(shouldRecoverBridge({ MITM_AUTO_RECOVER: "true" }, true, true), false);
  assert.equal(fs.statSync(path.join(dir, "runtime-intent.json")).mode & 0o777, 0o600);
  writeBridgeIntent(dir, false);
  assert.equal(
    shouldRecoverBridge({ MITM_AUTO_RECOVER: "true" }, readBridgeIntent(dir), false),
    false
  );
});
