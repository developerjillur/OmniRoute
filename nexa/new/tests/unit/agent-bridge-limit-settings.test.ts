import test from "node:test";
import assert from "node:assert/strict";
import { updateResilienceSchema } from "../../src/shared/validation/schemas/settings.ts";
import { isResourceNotFoundResponse } from "../../open-sse/services/errorClassifier.ts";
import { getResource404Bypass } from "../../src/sse/services/requestResourceHealth.ts";

test("queue editor accepts its complete payload with global concurrency disabled", () => {
  const result = updateResilienceSchema.safeParse({
    requestQueue: {
      autoEnableApiKeyProviders: false,
      requestsPerMinute: 60,
      minTimeBetweenRequestsMs: 350,
      concurrentRequests: 6,
      globalConcurrentRequests: 0,
      maxWaitMs: 30000,
      executionMaxWaitMs: 600000,
      maxQueueDepth: 0,
    },
  });
  assert.equal(result.success, true);
});

test("queue editor still rejects negative and excessive global concurrency", () => {
  for (const value of [-1, 100001]) {
    assert.equal(
      updateResilienceSchema.safeParse({ requestQueue: { globalConcurrentRequests: value } })
        .success,
      false
    );
  }
});

test("missing native thread state is request-scoped and cannot poison account health", () => {
  const error =
    'No thread state was found for the requested `previous_message_id`. Replay the full conversation with thread: {"type": "create"} to start a new Thread.';
  assert.equal(isResourceNotFoundResponse(error), true);
  assert.deepEqual(getResource404Bypass(404, error, "test-connection", { info() {} }), {
    shouldFallback: false,
    cooldownMs: 0,
  });
  assert.equal(getResource404Bypass(400, error, "test-connection", { info() {} }), null);
});

test("model and endpoint absence remain eligible for normal fallback handling", () => {
  for (const error of [
    "Model claude-opus-5-5 was not found",
    "Endpoint /v1/messages does not exist",
    "No thread state was found for an unknown model",
  ]) {
    assert.equal(isResourceNotFoundResponse(error), false);
  }
});
