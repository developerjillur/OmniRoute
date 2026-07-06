const ANTIGRAVITY_PROVIDER_ID = "antigravity";

export type AntigravityQuotaFamily =
  | "gemini-flash"
  | "gemini-pro"
  | "gemini"
  | "claude"
  | "other";

function normalizeModelId(model: string | null | undefined): string {
  return String(model || "")
    .trim()
    .toLowerCase();
}

/**
 * Classify Antigravity models by the quota bucket Google Cloud Code/Antigravity
 * appears to enforce. This is intentionally conservative:
 * - gemini-* / google/gemini-* variants share the Gemini family quota.
 * - claude-* and legacy cloud-* aliases are treated as the Claude/Cloud family.
 * - unknown models remain exact-model scoped for compatibility.
 */
export function getAntigravityQuotaFamily(
  model: string | null | undefined
): AntigravityQuotaFamily {
  const normalized = normalizeModelId(model).replace(/^antigravity\//, "");
  const slashIndex = normalized.indexOf("/");
  const bare = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;

  if (bare.startsWith("gemini-") || bare.includes("/gemini-") || bare.includes("gemini")) {
    // Google enforces SEPARATE quota buckets per tier (Flash vs Pro). Keeping them
    // independent means exhausting the small Pro quota (e.g. gemini-2.5-pro 429s)
    // does NOT lock out the Flash models, which have their own quota. (#antigravity-quota-tier)
    if (bare.includes("flash")) return "gemini-flash";
    if (bare.includes("pro")) return "gemini-pro";
    return "gemini";
  }
  if (
    bare.startsWith("claude-") ||
    bare.startsWith("cloud-") ||
    bare.includes("/claude-") ||
    bare.includes("/cloud-") ||
    bare.includes("anthropic")
  ) {
    return "claude";
  }
  return "other";
}

export function getQuotaScopedModelForProvider(
  provider: string | null | undefined,
  model: string | null | undefined
): string | null {
  if (!model) return null;
  if (provider !== ANTIGRAVITY_PROVIDER_ID) return model;
  const family = getAntigravityQuotaFamily(model);
  return family === "other" ? model : `family:${family}`;
}

export function getQuotaScopeLabelForProvider(
  provider: string | null | undefined,
  model: string | null | undefined
): string {
  if (provider !== ANTIGRAVITY_PROVIDER_ID) return "model";
  return getAntigravityQuotaFamily(model) === "other" ? "model" : "family";
}
