import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownsBridgeCommand, stopOwnedBridge } from "./stop-owned-bridge.mjs";

test("only the precise runtime Bridge command owns a PID", () => {
  const runtime = "/fixture/runtime";
  assert.equal(
    ownsBridgeCommand(
      "/usr/local/bin/node /fixture/runtime/lib/node_modules/omniroute/dist/src/mitm/server.cjs",
      runtime
    ),
    true
  );
  for (const command of [
    "/usr/local/bin/node /other/server.cjs",
    "/usr/local/bin/node /fixture/runtime/lib/node_modules/omniroute/dist/src/mitm/server.cjs --other",
    "/bin/sh /fixture/runtime/lib/node_modules/omniroute/dist/src/mitm/server.cjs",
  ]) {
    assert.equal(ownsBridgeCommand(command, runtime), false);
  }
});

test("stale metadata cannot terminate an unrelated live process", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-owned-stop-"));
  fs.mkdirSync(path.join(data, "mitm"));
  const record = path.join(data, "mitm/.mitm.pid");
  fs.writeFileSync(record, String(process.pid));
  assert.equal((await stopOwnedBridge(data, "/fixture/runtime")).staleRecordRemoved, true);
  assert.equal(fs.existsSync(record), false);
  assert.equal((await stopOwnedBridge(data, "/fixture/runtime")).stopped, false);
});
