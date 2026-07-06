/**
 * Antigravity project bootstrap — loadCodeAssist + onboardUser.
 *
 * The Google Cloud Code Assist API (/v1internal:models) requires a project
 * context on the OAuth token. That context is obtained in two steps:
 *   1. /v1internal:loadCodeAssist  — READS the assigned cloudaicompanionProject
 *      (+ subscription tier info) for the account.
 *   2. /v1internal:onboardUser     — for an eligible account that has NOT yet
 *      been assigned a project, ASSIGNS one (long-running op; poll until done).
 *
 * Historically this module only did step 1, so an eligible account (e.g. a
 * paid "Google AI Pro" / g1-pro-tier account) that had never completed the
 * Antigravity/Gemini onboarding returned an empty project and every :models
 * request failed with "Missing Google projectId". We now perform the
 * onboardUser step Google's own client does, so the project is minted
 * automatically. Results are memoized per-token for the process lifetime.
 *
 * Based on the Antigravity loadCodeAssist/onboardUser flow and the CLIProxyAPI
 * reference implementation in internal/runtime/executor/antigravity_executor.go.
 */

import {
  getAntigravityHeaders,
  getAntigravityLoadCodeAssistMetadata,
} from "./antigravityHeaders.ts";
import {
  getAntigravityBootstrapHeaders,
  type AntigravityClientProfile,
} from "./antigravityClientProfile.ts";
import { ANTIGRAVITY_BASE_URLS } from "../config/antigravityUpstream.ts";

const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
const ONBOARD_USER_PATH = "/v1internal:onboardUser";
const BOOTSTRAP_TIMEOUT_MS = 8_000;
const ONBOARD_POLL_INTERVAL_MS = 2_000;
const ONBOARD_MAX_ATTEMPTS = 6; // ~ up to 5 polls * 2s per base URL

/** Ordered list of loadCodeAssist endpoint URLs (mirrors the models discovery order). */
export function getAntigravityLoadCodeAssistUrls(): string[] {
  return ANTIGRAVITY_BASE_URLS.map((base) => `${base}${LOAD_CODE_ASSIST_PATH}`);
}

/** Ordered list of onboardUser endpoint URLs. */
export function getAntigravityOnboardUserUrls(): string[] {
  return ANTIGRAVITY_BASE_URLS.map((base) => `${base}${ONBOARD_USER_PATH}`);
}

/** Per-token memoization cache (lives for the process lifetime). */
const projectCache = new Map<string, string>();

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function getProjectCacheKey(accessToken: string, clientProfile: AntigravityClientProfile): string {
  return `${clientProfile}:${accessToken}`;
}

function bootstrapHeaders(
  accessToken: string,
  clientProfile: AntigravityClientProfile
): Record<string, string> {
  return clientProfile === "harness"
    ? getAntigravityBootstrapHeaders(clientProfile, accessToken)
    : getAntigravityHeaders("loadCodeAssist", accessToken);
}

/**
 * cloudaicompanionProject may be a plain string or an object with an id field.
 */
function extractProjectId(data: Record<string, unknown> | null | undefined): string {
  if (!data) return "";
  const raw = (data as Record<string, unknown>).cloudaicompanionProject;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string") {
    return ((raw as Record<string, unknown>).id as string).trim();
  }
  return "";
}

/** Pick a tier id to onboard with: paid → current → default allowed → first allowed → free-tier. */
function selectOnboardTierId(subscription: Record<string, unknown>): string {
  const pickId = (tier: unknown): string | null => {
    const record = tier && typeof tier === "object" ? (tier as Record<string, unknown>) : {};
    return typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
  };
  const paid = pickId(subscription.paidTier);
  if (paid) return paid;
  const current = pickId(subscription.currentTier);
  if (current) return current;
  const allowed = Array.isArray(subscription.allowedTiers) ? subscription.allowedTiers : [];
  const defaultTier = allowed.find(
    (t) => t && typeof t === "object" && (t as Record<string, unknown>).isDefault
  );
  const defaultId = pickId(defaultTier);
  if (defaultId) return defaultId;
  if (allowed.length) {
    const firstId = pickId(allowed[0]);
    if (firstId) return firstId;
  }
  return "free-tier";
}

/** Call loadCodeAssist and return the full parsed response (project + tiers), or null. */
async function callLoadCodeAssist(
  accessToken: string,
  fetchImpl: FetchLike,
  clientProfile: AntigravityClientProfile
): Promise<Record<string, unknown> | null> {
  const urls = getAntigravityLoadCodeAssistUrls();
  const headers = bootstrapHeaders(accessToken, clientProfile);

  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: getAntigravityLoadCodeAssistMetadata() }),
        signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(
          `[models] antigravity loadCodeAssist failed at ${url} (${response.status}) — trying next`
        );
        continue;
      }
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[models] antigravity loadCodeAssist threw for ${url}: ${msg} — trying next`);
    }
  }
  return null;
}

/**
 * Assign a Cloud AI Companion project to an eligible account via onboardUser.
 * onboardUser returns a long-running operation; we re-issue the same request
 * (idempotent) until it reports done + a project, mirroring the official client.
 * Returns the assigned project id, or null.
 */
async function tryOnboardUser(
  accessToken: string,
  subscription: Record<string, unknown>,
  fetchImpl: FetchLike,
  clientProfile: AntigravityClientProfile,
  preferredProjectId?: string
): Promise<string | null> {
  const tierId = selectOnboardTierId(subscription);
  const urls = getAntigravityOnboardUserUrls();
  const headers = bootstrapHeaders(accessToken, clientProfile);
  const existingProject = extractProjectId(subscription);
  // The current Gemini Code Assist free tier requires a user-defined
  // cloudaicompanionProject to onboard. Prefer the connection's stored project
  // (e.g. a GCP project the user created + enabled the Cloud AI Companion API on)
  // over the one loadCodeAssist returned, so a project-less account can still be
  // onboarded/registered instead of 400-ing with no project. (antigravity-onboard)
  const onboardProject =
    (typeof preferredProjectId === "string" && preferredProjectId.trim()) || existingProject;
  const body: Record<string, unknown> = {
    tierId,
    metadata: getAntigravityLoadCodeAssistMetadata(),
  };
  if (onboardProject) body.cloudaicompanionProject = onboardProject;

  for (const url of urls) {
    try {
      for (let attempt = 0; attempt < ONBOARD_MAX_ATTEMPTS; attempt++) {
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
        });
        if (!response.ok) {
          const errBody = await response.text().catch(() => "");
          console.warn(
            `[models] antigravity onboardUser failed at ${url} (${response.status}) proj=${onboardProject || "<none>"} tier=${tierId} — ${errBody.slice(0, 300)} — trying next`
          );
          break; // move to the next base URL
        }
        const op = (await response.json()) as Record<string, unknown>;
        // Project may be at op.response.cloudaicompanionProject or directly on op.
        const responseObj =
          op.response && typeof op.response === "object"
            ? (op.response as Record<string, unknown>)
            : op;
        const projectId = extractProjectId(responseObj);
        if (projectId) return projectId;
        if (op.done === true) break; // operation finished but yielded no project
        await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_INTERVAL_MS));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[models] antigravity onboardUser threw for ${url}: ${msg} — trying next`);
    }
  }
  return null;
}

/**
 * Ensure a project is assigned to the given access token. Reads via
 * loadCodeAssist; if the account has no project yet, runs onboardUser to
 * mint one. Idempotent + memoized per token for the process lifetime.
 *
 * Failures are non-fatal: the caller should proceed with the :models request
 * regardless (the stored project_id in the DB may still be valid).
 */
export async function ensureAntigravityProjectAssigned(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  clientProfile: AntigravityClientProfile = "ide",
  preferredProjectId?: string
): Promise<string | undefined> {
  const cacheKey = getProjectCacheKey(accessToken, clientProfile);
  if (projectCache.has(cacheKey)) {
    return projectCache.get(cacheKey); // already bootstrapped for this token
  }

  const subscription = await callLoadCodeAssist(accessToken, fetchImpl, clientProfile);
  if (!subscription) {
    return undefined; // all loadCodeAssist endpoints failed — non-fatal
  }

  let projectId = extractProjectId(subscription);

  if (!projectId) {
    // No project assigned yet — perform the onboardUser step Google's own
    // client does so an eligible account gets a Cloud AI Companion project.
    console.warn(
      "[models] antigravity: loadCodeAssist returned no project — running onboardUser to assign one"
    );
    const onboarded = await tryOnboardUser(
      accessToken,
      subscription,
      fetchImpl,
      clientProfile,
      preferredProjectId
    );
    if (onboarded) {
      projectId = onboarded;
      console.warn(`[models] antigravity onboardUser assigned project: ${projectId}`);
    }
  }

  if (projectId) {
    projectCache.set(cacheKey, projectId);
    return projectId;
  }
  // Non-fatal: proceed without caching.
  return undefined;
}

/** Exported for tests. */
export function clearAntigravityProjectCache(): void {
  projectCache.clear();
}

/** Exported for tests — inspect cache state. */
export function getAntigravityProjectFromCache(
  accessToken: string,
  clientProfile: AntigravityClientProfile = "ide"
): string | undefined {
  return projectCache.get(getProjectCacheKey(accessToken, clientProfile));
}
