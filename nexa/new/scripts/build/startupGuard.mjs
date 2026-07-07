// Pure, testable startup-safety guard (extracted from run-standalone.mjs so it
// can be unit-tested). Refuses a PUBLIC production bind that would expose the
// gateway or the dashboard to any network:
//   - REQUIRE_API_KEY off  → OpenAI-compatible API reachable unauthenticated.
//   - dashboard password == "CHANGEME" (the .env.example default) → full
//     management authority to anyone (SECURITY_AUDIT H2).
// Next's standalone server binds `HOSTNAME || 0.0.0.0` (all interfaces by
// default), so anything that is not an explicit loopback host counts as public.
// Operators who truly want an insecure public bind opt in via
// OMNIROUTE_ALLOW_INSECURE_PUBLIC=true.

const isTrue = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ refuse: boolean, reason: string|null }}
 */
export function evaluatePublicBindSafety(env) {
  const bindHost = String(env.HOSTNAME || "0.0.0.0").trim().toLowerCase();
  const isLoopbackBind =
    bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1";

  // Only a PUBLIC PRODUCTION bind is gated; loopback / dev / explicit opt-in pass.
  if (env.NODE_ENV !== "production" || isLoopbackBind || isTrue(env.OMNIROUTE_ALLOW_INSECURE_PUBLIC)) {
    return { refuse: false, reason: null };
  }

  if (!isTrue(env.REQUIRE_API_KEY)) {
    return {
      refuse: true,
      reason:
        `production bind to '${bindHost}' (non-loopback) with REQUIRE_API_KEY disabled would ` +
        `expose the API to unauthenticated callers. Set REQUIRE_API_KEY=true, or bind to loopback ` +
        `(HOSTNAME=127.0.0.1). To override deliberately, set OMNIROUTE_ALLOW_INSECURE_PUBLIC=true.`,
    };
  }

  const adminPassword = String(env.DASHBOARD_PASSWORD || env.INITIAL_PASSWORD || "").trim();
  if (adminPassword === "CHANGEME") {
    return {
      refuse: true,
      reason:
        `production bind to '${bindHost}' (non-loopback) with the default dashboard password ` +
        `(CHANGEME) would grant full management authority to anyone. Set a strong ` +
        `INITIAL_PASSWORD / DASHBOARD_PASSWORD, or bind to loopback (HOSTNAME=127.0.0.1). ` +
        `To override deliberately, set OMNIROUTE_ALLOW_INSECURE_PUBLIC=true.`,
    };
  }

  return { refuse: false, reason: null };
}
