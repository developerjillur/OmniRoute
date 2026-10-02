import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cached-quota-"));
process.env.DATA_DIR = data;
process.env.API_KEY_SECRET = "cached-quota-test-secret";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const quota = await import("../../src/domain/quotaCache.ts");
const resilience = await import("../../src/lib/resilience/settings.ts");
const schemas = await import("../../src/shared/validation/schemas/settings.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true });
});

test("cached quota switch persists false through unrelated resilience updates", () => {
  assert.equal(
    schemas.updateResilienceSchema.safeParse({
      quotaPreflight: { cachedQuotaFilteringEnabled: false },
    }).success,
    true
  );
  const disabled = resilience.mergeResilienceSettings(resilience.resolveResilienceSettings({}), {
    quotaPreflight: { cachedQuotaFilteringEnabled: false },
  });
  assert.equal(
    resilience.mergeResilienceSettings(disabled, { quotaShareConcurrencyLimit: { enabled: false } })
      .quotaPreflight.cachedQuotaFilteringEnabled,
    false
  );
  assert.equal(
    resilience.resolveResilienceSettings({ resilienceSettings: disabled }).quotaPreflight
      .cachedQuotaFilteringEnabled,
    false
  );
  assert.equal(
    resilience.resolveResilienceSettings({}).quotaPreflight.cachedQuotaFilteringEnabled,
    true
  );
});

test("disabled cached quota guard allows normal and pinned credential dispatch without spending extra usage", async () => {
  const connection = await providers.createProviderConnection({
    provider: "claude",
    authType: "apikey",
    name: "cache-test",
    apiKey: "sk-local-test",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { disableCooling: true, blockExtraUsage: true },
  });
  quota.setQuotaCache(connection.id, "claude", {
    "session (5h)": {
      remainingPercentage: 0,
      resetAt: new Date(Date.now() + 600000).toISOString(),
      claudeQuota: {
        kind: "session",
        active: true,
        severity: "critical",
        scopeKey: null,
        modelId: null,
        modelDisplayName: null,
      },
    },
  });
  const blocked = await auth.getProviderCredentials(
    "claude",
    null,
    [connection.id],
    "claude-opus-5-5"
  );
  assert.equal(blocked.allRateLimited, true);
  await settings.updateSettings({
    resilienceSettings: resilience.mergeResilienceSettings(
      resilience.resolveResilienceSettings({}),
      { quotaPreflight: { cachedQuotaFilteringEnabled: false } }
    ),
  });
  const direct = await auth.getProviderCredentials(
    "claude",
    null,
    [connection.id],
    "claude-opus-5-5"
  );
  assert.equal(direct.connectionId, connection.id);
  const pinned = await auth.getProviderCredentials(
    "claude",
    null,
    [connection.id],
    "claude-opus-5-5",
    { forcedConnectionId: connection.id }
  );
  assert.equal(pinned.connectionId, connection.id);
  const preflight = await auth.getProviderCredentialsWithQuotaPreflight(
    "claude",
    null,
    [connection.id],
    "claude-opus-5-5"
  );
  assert.equal(preflight.connectionId, connection.id);
  assert.equal(
    (await providers.getProviderConnectionById(connection.id)).providerSpecificData.blockExtraUsage,
    true
  );
  await providers.updateProviderConnection(connection.id, { isActive: false });
  assert.equal(
    await auth.getProviderCredentials("claude", null, [connection.id], "claude-opus-5-5"),
    null
  );
});
