# Native coding request fidelity, 2026-10-02

## Live observations

The running package is 3.8.51 at 0bda6c400. Cached quota filtering was disabled
through Global Routing settings and its saved database value was verified.
Quota preflight was already disabled. Two individually pinned, minimal requests
reached Anthropic and each returned HTTP 429. The current availability failure
therefore persists upstream even with local cached filtering disabled.

One connected Claude account had no weekly quota remaining; the other had no
five-hour quota remaining in the observed telemetry. A provider reset or another
authorized account with available quota is needed for successful real inference.
No paid overage was enabled. Account identities and credentials are omitted.

Prompt compression, semantic response caches, background degradation, and the
Claude system-transform pipeline were disabled in the inspected configuration.
Client cache markers use Auto preservation, session affinity is 24 hours, and
native model/effort selection remains controlled by the client.

## Overlay changes prepared

- Recognize the official `claude-cli/` user-agent in the shared client identity
  helper without recognizing arbitrary `x-app: cli` callers as Claude Code.
- Preserve native user/system text and tool descriptions instead of inserting
  zero-width characters into words such as `cursor`. Non-native client behavior
  remains unchanged.
- Skip optional generic system-block transformations for native Claude clients.
- Preserve the complete native tool list instead of silently truncating 150
  tools to the generic 128-tool default or a learned provider cap. A real provider
  rejection remains visible to the client.
- Disable same-family model substitution for Claude OAuth in
  `getNextFamilyFallback`. Other provider paths retain their existing behavior.
  This does not assert that every possible routing/fallback path is disabled.
- Bound the managed build process as documented in `deploy/BUILD-BUDGET.md`.

All changes are stored under `nexa/patches`, `nexa/new`, or `nexa/deploy` and are
reapplied during a managed build. Upstream updates still need the patch check and
validation gate; compatibility with unknown future releases cannot be guaranteed.

## Validation and deployment boundary

- Reproduced text mutation and 150-to-128 tool truncation before the fixes.
- Core typecheck passed.
- Full TypeScript ratchet returned to the existing 5830-error baseline with no
  additional errors; this is not a clean full-repository typecheck.
- Bridge regression: 539 passed, 0 failed.
- Bridge UI: 21 passed, 0 failed.
- Related model/native/security tests: 114 passed, 0 failed.
- Deployment helper/resource tests: 21 passed, 0 failed.
- A native `claude-opus-5-5[1m]` CLI probe timed out after 35 seconds. Canonical
  Opus requests reached Anthropic but returned quota errors. Successful native
  extended-context inference remains unverified in this pass.

These source changes have not been promoted to the running package. A successful
complete bounded build, artifact check, isolated real Claude completion, and
post-promotion native requests remain required. The live package and native app
bundle were not replaced during this review.

## Separate unfinished source work

The main checkout contains another session's uncommitted changes to
`modelFamilyFallback.ts`, `toolLimitDetector.ts`, its fallback test, and a new
text-fidelity test. The useful intent was reviewed and incorporated into this
overlay where supported by regression evidence. The uncommitted originals were
left intact. The generic tool limit was not raised to an arbitrary 10000;
native requests preserve their tool list through the scoped compatibility path.
