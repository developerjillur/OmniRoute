import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  getAntigravityQuotaFamily,
  getQuotaScopedModelForProvider,
} from "@omniroute/open-sse/services/antigravityQuotaFamily.ts";
import {
  clearAllModelLockouts,
  getModelLockoutInfo,
  isModelLocked,
  recordModelLockoutFailure,
} from "@omniroute/open-sse/services/accountFallback.ts";

const provider = "antigravity";

describe("Antigravity account quota-family cooldown", () => {
  beforeEach(() => {
    clearAllModelLockouts();
    vi.useRealTimers();
  });

  it("maps Gemini flash/pro to distinct sub-families and Claude/Cloud to Claude family", () => {
    // Gemini quota families are split (flash vs pro) so a Pro 429 does not cool
    // down Flash models on the same account (they have separate quota windows).
    expect(getAntigravityQuotaFamily("gemini-3.5-flash-medium")).toBe("gemini-flash");
    expect(getAntigravityQuotaFamily("google/gemini-3.5-flash-low")).toBe("gemini-flash");
    expect(getAntigravityQuotaFamily("gemini-2.5-pro")).toBe("gemini-pro");
    expect(getAntigravityQuotaFamily("gemini-3-pro-preview")).toBe("gemini-pro");
    expect(getAntigravityQuotaFamily("claude-sonnet-4")).toBe("claude");
    expect(getAntigravityQuotaFamily("cloud/claude-opus-4")).toBe("claude");
    expect(getAntigravityQuotaFamily("some-new-model")).toBe("other");
  });

  it("uses family-scoped lock key for Antigravity but preserves exact-model scope elsewhere", () => {
    expect(getQuotaScopedModelForProvider(provider, "gemini-3.5-flash-medium")).toBe(
      "family:gemini-flash"
    );
    expect(getQuotaScopedModelForProvider(provider, "gemini-3.5-flash-low")).toBe(
      "family:gemini-flash"
    );
    expect(getQuotaScopedModelForProvider(provider, "gemini-2.5-pro")).toBe("family:gemini-pro");
    expect(getQuotaScopedModelForProvider(provider, "claude-sonnet-4")).toBe("family:claude");
    expect(getQuotaScopedModelForProvider(provider, "unknown-model")).toBe("unknown-model");
    expect(getQuotaScopedModelForProvider("openai", "gemini-3.5-flash-medium")).toBe(
      "gemini-3.5-flash-medium"
    );
  });

  it("locks Gemini variants only on the same Antigravity account", () => {
    recordModelLockoutFailure(
      provider,
      "account-a",
      "gemini-3.5-flash-medium",
      "rate_limited",
      429,
      60_000,
      null,
      { maxCooldownMs: 300_000 }
    );

    expect(isModelLocked(provider, "account-a", "gemini-3.5-flash-medium")).toBe(true);
    expect(isModelLocked(provider, "account-a", "gemini-3.5-flash-low")).toBe(true);
    expect(isModelLocked(provider, "account-a", "claude-sonnet-4")).toBe(false);
    expect(isModelLocked(provider, "account-b", "gemini-3.5-flash-low")).toBe(false);
  });

  it("keeps Claude/Cloud family distinct from Gemini", () => {
    recordModelLockoutFailure(
      provider,
      "account-a",
      "claude-sonnet-4",
      "rate_limited",
      429,
      60_000,
      null,
      { maxCooldownMs: 300_000 }
    );

    expect(isModelLocked(provider, "account-a", "cloud/claude-opus-4")).toBe(true);
    expect(isModelLocked(provider, "account-a", "gemini-3.5-flash-low")).toBe(false);
  });

  it("honors exact upstream cooldowns and otherwise uses bounded inferred cooldown", () => {
    const upstream = recordModelLockoutFailure(
      provider,
      "account-a",
      "gemini-3.5-flash-medium",
      "rate_limited",
      429,
      1_000,
      null,
      { exactCooldownMs: 123_000, maxCooldownMs: 300_000 }
    );
    expect(upstream.cooldownMs).toBe(123_000);
    expect(
      getModelLockoutInfo(provider, "account-a", "gemini-3.5-flash-low")?.remainingMs
    ).toBeGreaterThan(100_000);

    const inferred = recordModelLockoutFailure(
      provider,
      "account-b",
      "gemini-3.5-flash-medium",
      "rate_limited",
      429,
      1_000,
      null,
      { maxCooldownMs: 5_000 }
    );
    expect(inferred.cooldownMs).toBeGreaterThan(0);
    expect(inferred.cooldownMs).toBeLessThanOrEqual(5_000);
  });
});
