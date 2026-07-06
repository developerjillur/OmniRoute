import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { getCloudAgentCorsHeaders } from "@/lib/cloudAgent/api";
import { setRuntimeAllowedOrigins } from "@/server/cors/origins";

/**
 * Regression guard for the cloud-agent CORS credential-theft vector.
 *
 * The cloud-agent routes are cookie-authenticated (requireManagementAuth ->
 * isDashboardSessionAuthenticated). Previously getCloudAgentCorsHeaders
 * reflected ANY request Origin back as Access-Control-Allow-Origin *and* set
 * Access-Control-Allow-Credentials: true — letting any website read a
 * logged-in operator's cloud-agent data cross-origin. The fix delegates to the
 * central allowlist (resolveAllowedOrigin) and only emits ACAO + credentials
 * for an explicitly allowlisted origin (fail-closed).
 */
function makeRequest(origin?: string): Request {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  return new Request("http://localhost:20128/api/v1/agents/tasks", { headers });
}

describe("cloud-agent CORS is fail-closed", () => {
  afterEach(() => {
    setRuntimeAllowedOrigins(null);
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_ALLOW_ALL;
    delete process.env.CORS_ORIGIN;
  });

  test("does NOT reflect an arbitrary origin with credentials", () => {
    const headers = getCloudAgentCorsHeaders(makeRequest("https://evil.example"));
    assert.equal(
      headers["Access-Control-Allow-Origin"],
      undefined,
      "arbitrary origin must not be reflected"
    );
    assert.equal(
      headers["Access-Control-Allow-Credentials"],
      undefined,
      "credentials must never be granted to a non-allowlisted origin"
    );
  });

  test("emits no ACAO when there is no Origin header", () => {
    const headers = getCloudAgentCorsHeaders(makeRequest());
    assert.equal(headers["Access-Control-Allow-Origin"], undefined);
    assert.equal(headers["Access-Control-Allow-Credentials"], undefined);
  });

  test("reflects an explicitly allowlisted origin WITH credentials", () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://dash.example";
    const headers = getCloudAgentCorsHeaders(makeRequest("https://dash.example"));
    assert.equal(headers["Access-Control-Allow-Origin"], "https://dash.example");
    assert.equal(headers["Access-Control-Allow-Credentials"], "true");
    assert.equal(headers["Vary"], "Origin");
  });

  test("still rejects a non-allowlisted origin when an allowlist is configured", () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://dash.example";
    const headers = getCloudAgentCorsHeaders(makeRequest("https://evil.example"));
    assert.equal(headers["Access-Control-Allow-Origin"], undefined);
    assert.equal(headers["Access-Control-Allow-Credentials"], undefined);
  });

  test("always advertises the standard methods regardless of origin", () => {
    const headers = getCloudAgentCorsHeaders(makeRequest("https://evil.example"));
    assert.match(headers["Access-Control-Allow-Methods"], /POST/);
    assert.match(headers["Access-Control-Allow-Headers"], /Authorization/);
  });
});
