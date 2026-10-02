# Claude quota recovery and scheduled routing

Date: 2026-10-03. Owner: Jillur Rahman.

## Problem and resulting behavior

Claude accounts with an exhausted session or weekly window must not receive repeated model requests. The existing cache could discard the actual reset after a 429, hydrate old observations without Claude scope metadata, optimistically release a wall when the clock elapsed, or override a model-specific wall after success on another model. Repeated retries then returned the same upstream quota error.

The child overlay preserves the governing reset and Claude scope. Routing skips exhausted accounts and selects an eligible sibling with the requested model. All global blocking windows must clear, so the latest global reset governs the next check. Independent model scopes use the earliest blocked model reset. No model request is used to check recovery. The existing background timer reads usage at the reset and confirms recovery before routing. Failed or unknown checks retry at most every five minutes. The normal timer can run the check up to approximately one minute after the deadline, subject to the Mac and service running.

## Durable implementation

- `nexa/patches/src__domain__quotaCache.ts.patch`: preserve 429 evidence; retain scope and reset in SQLite snapshots; reconstruct the schedule at boot; verify rather than assume recovery; refresh rotating OAuth credentials under the existing mutex; update the dashboard quota cache after a successful background read; prevent a success on one model from releasing another model's wall.
- `nexa/patches/src__domain__quotaCacheState.ts.patch`: shared refresh-attempt timestamps, preventing a failed usage read on every timer tick.
- `nexa/patches/src__lib__usage__providerLimits.ts.patch`: bulk automatic sync skips known future Claude walls when a saved usage cache exists; manual Refresh remains available; successful unchanged cache results count as successful syncs.
- `nexa/new/src/domain/claudeQuotaSchedule.ts`: pure reset-selection and refresh-backoff logic.
- `nexa/new/tests/unit/agent-bridge-quota-recovery.test.ts`: fourteen focused regressions, including restart, actual mocked OAuth rotation and usage calls, concurrent credential selection, manual inactive state, automatic bulk sync, and scoped healthy-override protection.

Only normalized interpretation is stored in quota snapshot `raw_data`. No tokens or raw provider payloads are written into reports. The upstream base is restored before commit. The manifest registers every patch and new file. Future managed updates reapply these patches, run the validation gate, smoke the package in isolation and retain rollback. An upstream change that conflicts with a patch stops promotion and requires review.

## Local settings

The live dashboard's Global Routing `Cached quota filtering` is enabled. `Quota preflight` remains disabled: no usage endpoint request is added to every chat. Per-key user/session/concurrency/USD limits and custom quota cutoffs remain disabled or unlimited as configured for the local owner. Actual provider exhaustion filtering is necessary to skip exhausted accounts.

Two connected Claude accounts remain active in the routing pool. The weekly-exhausted account is skipped based on quota metadata, not manually deactivated, so it can recover automatically. A manually deactivated account is never auto-enabled. Low Priority Mode and automatic limit-reset-credit redemption remain off; those are different provider features and are not needed for this scheduler. Paid extra usage is not enabled.

## Evidence and validation

The initial five regression cases failed before the fix. A separate scoped-success case also failed before its fix. The final fourteen cases pass. Related healthy-override, quota persistence and bulk-sync suites are covered separately, and the deployment gate reruns the Bridge/UI/security/native-fidelity tests and type checks. TypeScript's existing upstream baseline remains unchanged; new errors must not be accepted by increasing it.

Before promotion, a fresh live usage read on 2026-10-03 at approximately 00:10 Asia/Dhaka showed the formerly session-exhausted account with 100% session quota remaining and 68% weekly quota remaining. A small live Opus request returned HTTP 200 with `ROUTE_OK`. The sibling remained weekly-exhausted until its reported reset on 2026-10-06 at 09:00 Asia/Dhaka. These are point-in-time observations, not unlimited capacity or full native-app parity evidence.

Build and promotion results, exact commit and package hash, final native requests and cleanup are recorded in the dated local deployment handoff after the managed updater completes. Evidence is under the owner's local `Documents/Codex/2026-10-02/omniroute-stability-2245` directory.

## Operational limits and recovery

When every eligible account has a real provider quota wall, routing reports unavailability with the earliest account recovery time. It does not remove Anthropic's subscription quota, fabricate a response, change model or enable spending. Account recovery means eligible for subsequent requests; it does not replay already-failed background jobs or continue a native chat automatically.

The Mac must be awake and OmniRoute running for a timed check. After restart, SQLite snapshots reconstruct the schedule; an overdue check runs at startup. An invalid/revoked token or unavailable usage endpoint retains the known wall and reschedules the check. Re-authentication may be necessary for genuinely revoked credentials. Unknown-reset 429s use a bounded five-minute usage recheck; normal request-rate 429s remain distinct from weekly/session exhaustion.

## Post-update checks

1. Confirm the pristine upstream base and successful overlay patch application.
2. Require core typecheck, non-skipped down-only TypeScript ratchet and regression gates.
3. Build with the bounded runner: 6 GiB Node heap, 8 GiB descendant RSS cap, one Next worker and reduced process priority.
4. Smoke the actual installed candidate in isolation, including a real small Claude response.
5. Promote only after gates pass; verify local HTTPS ingress, Bridge state and a real native Claude Code request.
6. Check weekly-exhausted accounts are skipped and available accounts answer the requested model. Do not treat dashboard health alone as native-route proof.
