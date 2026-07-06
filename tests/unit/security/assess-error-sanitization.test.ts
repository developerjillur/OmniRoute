import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { POST } from "@/app/api/assess/route";

/**
 * Regression guard for Hard Rule #12 on POST /api/assess.
 *
 * The handler previously returned `error.message` verbatim in the 500 body,
 * which can leak internal paths / library internals (and the route is
 * unauthenticated when requireLogin=false). Malformed JSON makes
 * `request.json()` throw before validation, deterministically exercising the
 * catch block, so we can assert the response body is sanitized.
 */
describe("POST /api/assess sanitizes error responses", () => {
  test("500 body carries no absolute path or stack frame", async () => {
    const req = new Request("http://localhost:20128/api/assess", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is : not valid json",
    });

    // Cast: the handler only calls request.json(), available on Request.
    const res = await POST(req as never);

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: unknown };
    const message = typeof body.error === "string" ? body.error : JSON.stringify(body.error);

    assert.ok(!/\/(home|Users|var|root|opt)\//.test(message), `leaked absolute path: ${message}`);
    assert.ok(!/\bat \/?\w+.*:\d+:\d+/.test(message), `leaked stack frame: ${message}`);
    assert.ok(!message.includes(".ts:"), `leaked source location: ${message}`);
    assert.ok(message.length > 0, "error message should not be empty");
  });
});
