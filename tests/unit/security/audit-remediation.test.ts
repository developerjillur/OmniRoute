/**
 * Regression tests for SECURITY_AUDIT_REPORT.md remediations (verified + fixed
 * against v3.8.44). Covers M1 (guardrail override gate), M6 (inspector header
 * masking), M7 (cloud-sync fail-closed), M3 (DNS-rebinding guard).
 *
 * All dynamic imports resolve BEFORE any test() is registered (interleaving
 * await with test() makes node:test miss the later-registered cases).
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

// M7 must capture an EMPTY secret at module-eval time — clear env before importing.
delete process.env.OMNIROUTE_CLOUD_SYNC_SECRET;
delete process.env.OMNIROUTE_CLOUD_SYNC_ALLOW_UNVERIFIED;

const dns = (await import("node:dns")).default;
const { resolveDisabledGuardrails } = await import("../../../src/lib/guardrails/registry.ts");
const { sanitizeHeaders } = await import("../../../src/mitm/sanitizeHeaders.ts");
const { verifyCloudSignature } = await import("../../../src/lib/cloudSync.ts");
const { safeOutboundFetch, SafeOutboundFetchError } = await import(
  "../../../src/shared/network/safeOutboundFetch.ts"
);

// ── M1: client-supplied guardrail disables require a per-key opt-in ──────────
test("M1: client body/header guardrail-disables are IGNORED without the per-key opt-in", () => {
  const disabled = resolveDisabledGuardrails({
    apiKeyInfo: { disabledGuardrails: ["operator-set"] },
    body: {
      disabledGuardrails: ["prompt-injection"],
      metadata: { disabledGuardrails: ["pii-masker"] },
    },
    headers: { "x-omniroute-disabled-guardrails": "prompt-injection" },
  });
  assert.deepEqual(disabled, ["operator-set"], "only the operator's per-key list applies");
  assert.ok(!disabled.includes("prompt-injection"), "client body disable must be ignored");
  assert.ok(!disabled.includes("pii-masker"), "client metadata disable must be ignored");
});

test("M1: client disables ARE honored when the key opts in (allowClientGuardrailOverride)", () => {
  const disabled = resolveDisabledGuardrails({
    apiKeyInfo: { allowClientGuardrailOverride: true },
    body: { disabledGuardrails: ["prompt-injection"] },
    headers: {},
  });
  assert.ok(disabled.includes("prompt-injection"), "opted-in key may disable client-side");
});

// ── M6: inspector header sanitizer masks set-cookie ──────────────────────────
test("M6: sanitizeHeaders masks set-cookie (response-side credential)", () => {
  const out = sanitizeHeaders({ "set-cookie": "session=SUPERSECRETVALUE; HttpOnly", "x-ok": "1" });
  assert.ok(!JSON.stringify(out).includes("SUPERSECRETVALUE"), "set-cookie value must be masked");
  assert.equal(out["x-ok"], "1", "non-secret headers pass through");
});

// ── M7: cloud-sync verification fails closed when the secret is unset ─────────
test("M7: verifyCloudSignature FAILS CLOSED when secret unset but a signature is present", () => {
  assert.equal(
    verifyCloudSignature("{}", "deadbeef"),
    false,
    "a claimed-signed payload we cannot verify must be rejected"
  );
});

// ── M3: DNS-rebinding — a host that RESOLVES to metadata is blocked ───────────
test("M3: block-metadata rejects a host that RESOLVES to 169.254.169.254 (rebinding)", async () => {
  mock.method(dns.promises, "lookup", async () => [{ address: "169.254.169.254", family: 4 }]);
  try {
    await assert.rejects(
      () =>
        safeOutboundFetch("http://rebind.example.test/v1/models", {
          guard: "block-metadata",
          bypassProxyPatch: true,
          allowRedirect: false,
          retry: false,
          timeoutMs: 1000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SafeOutboundFetchError, "must be a guard error");
        assert.match(String((err as Error).message), /rebinding|metadata|blocked/i);
        return true;
      }
    );
  } finally {
    mock.restoreAll();
  }
});

test("M3: block-metadata ALLOWS a host that resolves to a normal public IP (passes guard)", async () => {
  mock.method(dns.promises, "lookup", async () => [{ address: "192.0.2.1", family: 4 }]);
  try {
    await assert.rejects(
      () =>
        safeOutboundFetch("http://ok.example.test/v1/models", {
          guard: "block-metadata",
          bypassProxyPatch: true,
          allowRedirect: false,
          retry: false,
          timeoutMs: 800,
        }),
      (err: unknown) => {
        assert.doesNotMatch(
          String((err as Error).message),
          /rebinding|resolves to a blocked/i,
          "a public host must pass the DNS-rebinding guard"
        );
        return true;
      }
    );
  } finally {
    mock.restoreAll();
  }
});
