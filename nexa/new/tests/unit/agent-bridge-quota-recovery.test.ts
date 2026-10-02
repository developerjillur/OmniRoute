import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-quota-recovery-"));
process.env.DATA_DIR = data;
process.env.API_KEY_SECRET = "quota-recovery-test-secret";
const core = await import("../../src/lib/db/core.ts");
const quota = await import("../../src/domain/quotaCache.ts");
const schedule = await import("../../src/domain/claudeQuotaSchedule.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const resilience = await import("../../src/lib/resilience/settings.ts");

function window(kind: "session" | "weekly_all" | "weekly_scoped", resetAt: string, active = true) {
  return {
    remainingPercentage: active ? 0 : 80,
    resetAt,
    claudeQuota: {
      kind,
      active,
      severity: active ? "critical" : "normal",
      scopeKey: kind === "weekly_scoped" ? "model:fable" : null,
      modelId: kind === "weekly_scoped" ? "claude-fable-5-1" : null,
      modelDisplayName: kind === "weekly_scoped" ? "Fable" : null,
    },
  };
}

test.beforeEach(() => quota.__clearForTests());
test.afterEach(() => mock.restoreAll());
test.after(() => {
  quota.stopBackgroundRefresh();
  core.resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true });
});

test("one exhausted weekly window retains its real reset instead of a five-minute retry", () => {
  const reset = new Date(Date.now() + 3 * 86400000).toISOString();
  quota.setQuotaCache("weekly", "claude", {
    "session (5h)": window("session", reset, false),
    "weekly (7d)": window("weekly_all", reset),
  });
  assert.equal(quota.getQuotaCache("weekly")?.nextResetAt, reset);
});

test("an upstream 429 preserves the known session reset and quota evidence", () => {
  const reset = new Date(Date.now() + 600000).toISOString();
  quota.setQuotaCache("wall", "claude", {
    "session (5h)": window("session", reset),
    "weekly (7d)": window("weekly_all", reset, false),
  });
  quota.markAccountExhaustedFrom429("wall", "claude");
  assert.equal(quota.getQuotaCache("wall")?.nextResetAt, reset);
  assert.ok(quota.getQuotaCache("wall")?.quotas["session (5h)"]);
});

test("restart hydration keeps a partial Claude quota wall and the real deadline", () => {
  const reset = new Date(Date.now() + 86400000).toISOString();
  quota.setQuotaCache("restart", "claude", {
    "session (5h)": window("session", reset, false),
    "weekly (7d)": window("weekly_all", reset),
  });
  quota.__clearForTests();
  assert.equal(quota.isQuotaExhaustedForRequest("restart", "claude", "claude-opus-5-5"), true);
  assert.equal(quota.getQuotaCache("restart")?.nextResetAt, reset);
});

test("a reset timestamp triggers a quota check, not optimistic activation", () => {
  const reset = new Date(Date.now() + 60000).toISOString();
  quota.setQuotaCache("verify", "claude", { "session (5h)": window("session", reset) });
  mock.method(Date, "now", () => Date.parse(reset) + 1000);
  assert.equal(quota.isQuotaExhaustedForRequest("verify", "claude", "claude-opus-5-5"), true);
  quota.setQuotaCache("verify", "claude", { "session (5h)": window("session", reset, false) });
  assert.equal(quota.isQuotaExhaustedForRequest("verify", "claude", "claude-opus-5-5"), false);
});

test("restart preserves model-specific quota without parking other Claude models", () => {
  const reset = new Date(Date.now() + 86400000).toISOString();
  quota.setQuotaCache(
    "scope",
    "claude",
    {},
    { "weekly fable (7d)": window("weekly_scoped", reset) }
  );
  quota.__clearForTests();
  assert.equal(quota.isQuotaExhaustedForRequest("scope", "claude", "claude-fable-5-1"), true);
  assert.equal(quota.isQuotaExhaustedForRequest("scope", "claude", "claude-opus-5-5"), false);
});

test("known global walls schedule the latest blocking reset, without repeated probes", () => {
  const now = Date.now();
  const sessionReset = now + 600000;
  const weeklyReset = now + 86400000;
  quota.setQuotaCache("schedule", "claude", {
    "session (5h)": window("session", new Date(sessionReset).toISOString()),
    "weekly (7d)": window("weekly_all", new Date(weeklyReset).toISOString()),
  });
  const entry = quota.getQuotaCache("schedule")!;
  assert.equal(schedule.getClaudeQuotaSchedule(entry)?.checkAt, weeklyReset);
  assert.equal(schedule.shouldRefreshQuotaEntry(entry, sessionReset), false);
  assert.equal(schedule.shouldRefreshQuotaEntry(entry, weeklyReset - 1), false);
  assert.equal(schedule.shouldRefreshQuotaEntry(entry, weeklyReset), true);
});

test("a failed reset refresh is rescheduled, not repeated on every background tick", () => {
  const now = Date.now();
  quota.setQuotaCache("retry", "claude", {
    "session (5h)": window("session", new Date(now + 60000).toISOString()),
  });
  const entry = quota.getQuotaCache("retry")!;
  const attemptedAt = now + 60000;
  assert.equal(schedule.shouldRefreshQuotaEntry(entry, attemptedAt + 60000, attemptedAt), false);
  assert.equal(schedule.shouldRefreshQuotaEntry(entry, attemptedAt + 299999, attemptedAt), false);
  assert.equal(schedule.shouldRefreshQuotaEntry(entry, attemptedAt + 300000, attemptedAt), true);
});

test("unknown 429 reset uses a bounded five-minute usage recheck", () => {
  const now = Date.now();
  quota.markAccountExhaustedFrom429("unknown", "claude");
  const entry = quota.getQuotaCache("unknown")!;
  entry.fetchedAt = now;
  assert.equal(schedule.shouldRefreshQuotaEntry(entry, now + 299999), false);
  assert.equal(schedule.shouldRefreshQuotaEntry(entry, now + 300000), true);
});

test("empty or unknown quota responses do not erase a scheduled wall", () => {
  const reset = new Date(Date.now() + 600000).toISOString();
  quota.setQuotaCache("unverified", "claude", { "session (5h)": window("session", reset) });
  quota.setQuotaCache("unverified", "claude", {});
  quota.setQuotaCache("unverified", "claude", {
    telemetry: { remainingPercentage: 0, fractionReported: false },
  });
  assert.equal(quota.getQuotaCache("unverified")?.nextResetAt, reset);
  assert.equal(quota.isQuotaExhaustedForRequest("unverified", "claude", "claude-opus-5-5"), true);
});

test("parallel sessions skip exhausted accounts and recover after fresh quota without changing activation", async () => {
  await settings.updateSettings({
    resilienceSettings: resilience.mergeResilienceSettings(
      resilience.resolveResilienceSettings({}),
      { quotaPreflight: { cachedQuotaFilteringEnabled: true } }
    ),
  });
  const first = await providers.createProviderConnection({
    provider: "claude",
    authType: "apikey",
    name: "wall-first",
    apiKey: "test-key-a",
    isActive: true,
    providerSpecificData: { disableCooling: true },
  });
  const second = await providers.createProviderConnection({
    provider: "claude",
    authType: "apikey",
    name: "available-second",
    apiKey: "test-key-b",
    isActive: true,
    providerSpecificData: { disableCooling: true },
  });
  const firstId = first.id;
  const secondId = second.id;
  assert.ok(typeof firstId === "string");
  assert.ok(typeof secondId === "string");
  const reset = new Date(Date.now() + 600000).toISOString();
  quota.setQuotaCache(firstId, "claude", { "session (5h)": window("session", reset) });
  quota.setQuotaCache(secondId, "claude", { "session (5h)": window("session", reset, false) });
  const options = { bypassQuotaPolicy: true };
  const selected = await Promise.all(
    Array.from({ length: 20 }, () =>
      auth.getProviderCredentials("claude", null, [firstId, secondId], "claude-opus-5-5", options)
    )
  );
  assert.ok(
    selected.every(
      (result) => result && "connectionId" in result && result.connectionId === secondId
    )
  );
  const unavailable = await auth.getProviderCredentials(
    "claude",
    null,
    [firstId],
    "claude-opus-5-5",
    options
  );
  assert.ok(unavailable && "allRateLimited" in unavailable && "retryAfter" in unavailable);
  assert.equal(unavailable.allRateLimited, true);
  assert.equal(unavailable.retryAfter, reset);
  quota.setQuotaCache(firstId, "claude", { "session (5h)": window("session", reset, false) });
  const recovered = await auth.getProviderCredentials(
    "claude",
    null,
    [firstId],
    "claude-opus-5-5",
    options
  );
  assert.ok(recovered && "connectionId" in recovered);
  assert.equal(recovered.connectionId, firstId);
  assert.equal((await providers.getProviderConnectionById(firstId)).isActive, true);
  await providers.updateProviderConnection(firstId, { isActive: false });
  quota.setQuotaCache(firstId, "claude", { "session (5h)": window("session", reset, false) });
  const inactive = await auth.getProviderCredentials(
    "claude",
    null,
    [firstId],
    "claude-opus-5-5",
    options
  );
  assert.ok(!inactive || !("connectionId" in inactive) || inactive.connectionId !== firstId);
  assert.equal((await providers.getProviderConnectionById(firstId)).isActive, false);
});

test("boot reconstructs the scheduled wall without waiting for a chat request", async () => {
  const connection = await providers.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "boot-wall",
    accessToken: "test-boot-token",
    isActive: true,
  });
  const connectionId = connection.id;
  assert.ok(typeof connectionId === "string");
  const reset = new Date(Date.now() + 86400000).toISOString();
  quota.setQuotaCache(connectionId, "claude", { "weekly (7d)": window("weekly_all", reset) });
  quota.__clearForTests();
  quota.startBackgroundRefresh();
  try {
    for (let i = 0; i < 50 && !quota.getQuotaCache(connectionId); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(quota.getQuotaCache(connectionId)?.nextResetAt, reset);
    assert.equal(quota.isQuotaExhaustedForRequest(connectionId, "claude", "claude-opus-5-5"), true);
  } finally {
    quota.stopBackgroundRefresh();
  }
});

test("a due background check refreshes expired credentials and restores routing from usage only", async () => {
  const now = Date.now();
  const connection = await providers.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "due-wall",
    accessToken: "test-old-access",
    refreshToken: "test-old-refresh",
    expiresAt: new Date(now - 60000).toISOString(),
    isActive: true,
  });
  const connectionId = connection.id;
  assert.ok(typeof connectionId === "string");
  quota.setQuotaCache(connectionId, "claude", {
    "session (5h)": window("session", new Date(now - 1000).toISOString()),
  });
  let tokenCalls = 0;
  let usageCalls = 0;
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/oauth/token")) {
      tokenCalls++;
      return Response.json({
        access_token: "test-fresh-access",
        refresh_token: "test-fresh-refresh",
        expires_in: 3600,
      });
    }
    if (url.endsWith("/api/oauth/usage")) {
      usageCalls++;
      return Response.json({
        five_hour: { utilization: 0, resets_at: new Date(now + 18000000).toISOString() },
        seven_day: { utilization: 10, resets_at: new Date(now + 86400000).toISOString() },
      });
    }
    if (url.includes("/claude_cli/bootstrap")) return Response.json({});
    throw new Error("Unexpected test endpoint");
  });
  mock.method(Date, "now", () => now + 360000);
  quota.startBackgroundRefresh();
  try {
    for (
      let i = 0;
      i < 200 && quota.isQuotaExhaustedForRequest(connectionId, "claude", "claude-opus-5-5");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      quota.isQuotaExhaustedForRequest(connectionId, "claude", "claude-opus-5-5"),
      false
    );
    assert.equal(tokenCalls, 1);
    assert.equal(usageCalls, 1);
    const cacheDb = await import("../../src/lib/db/providerLimits.ts");
    const displayCache = cacheDb.getProviderLimitsCache(connectionId);
    assert.equal(displayCache?.source, "scheduled");
    assert.equal(displayCache?.quotas?.["session (5h)"]?.["remainingPercentage"], 100);
    const stored = await providers.getProviderConnectionById(connectionId);
    assert.equal(stored.accessToken, "test-fresh-access");
    assert.equal(stored.isActive, true);
  } finally {
    quota.stopBackgroundRefresh();
  }
});

test("automatic bulk quota refresh skips future Claude walls while manual refresh stays available", async () => {
  const allConnections = await providers.getProviderConnections({ isActive: true });
  for (const row of allConnections) {
    const id = row.id;
    if (typeof id === "string") await providers.updateProviderConnection(id, { isActive: false });
  }
  const connection = await providers.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "bulk-wall",
    accessToken: "test-bulk-access",
    refreshToken: "test-bulk-refresh",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    isActive: true,
  });
  const id = connection.id;
  assert.ok(typeof id === "string");
  const reset = new Date(Date.now() + 86400000).toISOString();
  const quotas = { "weekly (7d)": window("weekly_all", reset) };
  quota.setQuotaCache(id, "claude", quotas);
  const cacheDb = await import("../../src/lib/db/providerLimits.ts");
  cacheDb.setProviderLimitsCache(id, {
    quotas,
    modelQuotas: {},
    plan: "max",
    message: null,
    fetchedAt: new Date().toISOString(),
    source: "scheduled",
  });
  const bulk = await import("../../src/lib/usage/providerLimits.ts");
  let usageCalls = 0;
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/oauth/usage")) {
      usageCalls++;
      return Response.json({ seven_day: { utilization: 100, resets_at: reset } });
    }
    if (url.includes("/claude_cli/bootstrap")) return Response.json({});
    throw new Error("Unexpected test endpoint");
  });
  const skipped = await bulk.syncAllProviderLimits({ source: "scheduled" });
  assert.equal(skipped.total, 1);
  assert.equal(skipped.succeeded, 1);
  assert.equal(skipped.failed, 0);
  assert.equal(usageCalls, 0);
  await bulk.syncAllProviderLimits({ source: "manual" });
  assert.equal(usageCalls, 1);
});

test("success on another model never releases a known Claude quota wall", () => {
  const reset = new Date(Date.now() + 600000).toISOString();
  quota.setQuotaCache(
    "scoped-success",
    "claude",
    {},
    {
      "weekly fable (7d)": window("weekly_scoped", reset),
    }
  );
  quota.markQuotaHealthy("scoped-success");
  assert.equal(
    quota.isQuotaExhaustedForRequest("scoped-success", "claude", "claude-fable-5-1"),
    true
  );
  assert.equal(
    quota.isQuotaExhaustedForRequest("scoped-success", "claude", "claude-opus-5-5"),
    false
  );
  quota.setQuotaCache("global-success", "claude", { "weekly (7d)": window("weekly_all", reset) });
  quota.markQuotaHealthy("global-success");
  assert.equal(
    quota.isQuotaExhaustedForRequest("global-success", "claude", "claude-opus-5-5"),
    true
  );
});
