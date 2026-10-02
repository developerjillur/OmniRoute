import test from "node:test";
import assert from "node:assert/strict";
import { inspectCompiledCountRoute } from "./bridge-gate.mjs";

const route =
  "f?.countTokens?.({model:b.model,body:d,credentials:c,clientHeaders:Object.fromEntries(a.headers.entries()),signal:a.signal,log:r})";
test("Webpack count route preserves native headers and request cancellation", () => {
  assert.equal(inspectCompiledCountRoute(route), true);
});
test("count route without headers or cancellation still fails the contract", () => {
  assert.equal(
    inspectCompiledCountRoute(
      route.replace("clientHeaders:Object.fromEntries(a.headers.entries()),", "")
    ),
    false
  );
  assert.equal(inspectCompiledCountRoute(route.replace("signal:a.signal,", "")), false);
  assert.equal(inspectCompiledCountRoute('R.c("server/chunks/route-123.js")'), false);
});
