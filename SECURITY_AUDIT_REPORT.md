# OmniRoute — Security Scan, Optimization & Health Report

**Date:** 2026-07-06
**Version audited:** 3.8.45 (`3ddcee63`)
**Branch:** `claude/omniroute-security-scan-i03n81`
**Scope:** Full-repository supply-chain + source security scan, malware check, dependency audit, build/typecheck/lint/test setup, live server bring-up, and optimization review of `src/`, `open-sse/`, `electron/`, `scripts/`, `bin/`, and config.

---

## 1. Executive Summary

OmniRoute is a **well-engineered, defense-in-depth codebase**. The scan found **no malware, no backdoors, and no known-vulnerable dependencies** (npm audit: 0/2041). The cryptographic core, the SSRF-defense layer, and the authorization pipeline are all notably strong. The issues that exist are a small set of concrete, fixable hardening gaps — none of them a remotely-exploitable pre-auth RCE or data-exfiltration hole in the default configuration.

| Dimension                                | Result                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Malware / backdoor                       | **None found** — every install hook and obfuscated-looking blob traced to a benign, documented purpose              |
| Dependency vulnerabilities               | **0** (`npm audit`: 0 critical / 0 high / 0 moderate / 0 low across 2041 deps)                                      |
| Lockfile provenance                      | **Clean** — 2033/2034 sha512-pinned, all `registry.npmjs.org` (only the local `open-sse` workspace is off-registry) |
| Type safety                              | **Clean** (`typecheck:core` — the one error is an uninstalled _optional_ ML dep, not a code defect)                 |
| Lint                                     | **Clean** (0 errors)                                                                                                |
| Unit tests (vitest: MCP/autoCombo/cache) | **232 passed / 232**                                                                                                |
| Live server bring-up                     | **Healthy** (`/api/monitoring/health` → `status: "healthy"`)                                                        |
| Findings                                 | **2 High, 9 Medium, 15 Low/Informational**                                                                          |
| Fixes shipped this session               | **3** (1 High, 2 Medium/bug) — with regression tests, all green                                                     |

### Verdict

Safe to run. Prioritize the two High findings (**H1 cloud-agent CORS — fixed here**; **H2 default admin password**) and the Medium hardening items before exposing an instance beyond localhost.

---

## 2. Setup & Test Execution (what was run)

The environment was set up and exercised end-to-end:

```
npm install                 → OK (2041 deps; postinstall hooks reviewed & clean)
npm audit                   → 0 vulnerabilities
npm run typecheck:core      → clean (only missing optional @huggingface/transformers)
npm run lint                → 0 errors
npm run test:vitest         → 24 files / 232 tests PASSED
npm run dev                 → server boots; /api/monitoring/health = "healthy"
```

**Live server pipeline checks (loopback):**

| Request                                         | Result                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| `GET /api/v1/models`                            | 200 — returns combo model catalog (`auto/best-coding`, …) |
| `POST /api/v1/chat/completions` (malformed)     | 400 `"Missing model"` — Zod validation works              |
| `POST /api/v1/chat/completions` (unknown model) | 400 — **sanitized** error, no stack/path leak             |
| `POST /api/assess` (malformed)                  | 401/500 — **sanitized** (after fix)                       |
| Cloud-agent CORS w/ hostile `Origin`            | **no `Allow-Credentials`** (after fix)                    |

> **Note on a dev-only blocker:** in Turbopack dev, a missing _optional_ dependency (`@huggingface/transformers`, whose native `onnxruntime-node` binary cannot be fetched in this locked-down network) makes the dev server return 500 for every route until the module resolves. The import itself is correctly lazy (`await import()`, never module-level — `src/lib/memory/embedding/transformersLocal.ts:32`), so **production runtime is unaffected**; this is purely a dev-experience papercut (see §8). A one-file local stub restored the dev server to healthy for this audit.

---

## 3. Malware & Supply-Chain Verdict — **CLEAN**

No evidence of malware or a backdoor. Details:

- **Install lifecycle hooks:** the only `postinstall` is `scripts/build/postinstall.mjs` (+ `scripts/postinstall.mjs`). Both only copy pre-built native binaries (`better-sqlite3`, `wreq-js`) into the standalone bundle, co-locate optional ML packages, and sync a local `.env`. **No network exfiltration, no credential-store writes, no shell interpolation of untrusted input.**
- **Secret generation** (`scripts/dev/sync-env.mjs`, `bootstrap-env.mjs`) uses `crypto.randomBytes` locally and never transmits.
- **`child_process` usage** across the repo uses arg-array `execFile`/`spawn` against local tooling; none pipes network content into a shell.
- **No `process.env` is serialized to a network body** anywhere.
- **The XOR-masked blobs in `open-sse/utils/publicCreds.ts` decode to _public_ OAuth client IDs** (Gemini `…apps.googleusercontent.com`, Codex `app_…`, GitHub Copilot `Iv1.…`), masked only to silence secret scanners — exactly as documented. No hidden URLs/commands.
- **`eval` hits** are Redis-side Lua (`redis.eval`) and OmniRoute's own _scanners that detect_ `eval(base64)` in downloaded skill content — defensive, not offensive.

Supply-chain controls already in place and working: `lockfile-lint` (`--validate-https --validate-integrity`), a 130-entry typosquat allowlist with a 72-hour new-dep age-cooldown (`check-deps.mjs`), license checking, and a `.npmrc` with no registry redirect or auth token.

---

## 4. Findings by Severity

Legend: **[FIXED ✅]** = remediated in this session with a regression test · **[OPEN]** = documented recommendation.

### HIGH

#### H1 — Cloud-agent CORS reflected any Origin _with credentials_ **[FIXED ✅]**

`src/lib/cloudAgent/api.ts` · routes `src/app/api/v1/agents/**`
The cloud-agent routes are cookie-authenticated (`requireManagementAuth` → `isDashboardSessionAuthenticated`), yet `getCloudAgentCorsHeaders` returned `Access-Control-Allow-Origin: <reflected origin>` **and** `Access-Control-Allow-Credentials: true`. A logged-in operator visiting a malicious page could have their session cookie used to read cloud-agent data / drive task creation cross-origin.
**Fix:** delegate to the central allowlist (`resolveAllowedOrigin`); emit `Allow-Origin` + credentials **only** for an explicitly allowlisted origin (fail-closed) — matching the project's own documented CORS contract. Verified live: no `Allow-Credentials` for a hostile origin.

#### H2 — Default admin password ships in the template **[OPEN]**

`.env.example` → `INITIAL_PASSWORD=CHANGEME`; `npm install` auto-generates `.env` from it. A fresh install that isn't changed accepts `CHANGEME` for the dashboard admin login (full management authority). Bootstrap only _warns_ — there is no forced first-boot rotation.
**Recommendation:** refuse to start (or force a password change) when `INITIAL_PASSWORD === "CHANGEME"` on a non-loopback bind. _Mitigations present:_ bcrypt cost-12 hashing, no hardcoded `JWT_SECRET` fallback, loud warning.

### MEDIUM

#### M1 — Operator-mandated guardrails are client-disableable **[OPEN]**

`src/lib/guardrails/registry.ts:70` (`resolveDisabledGuardrails`) merges disabled-guardrail names from **client-controlled** `body.disabledGuardrails`, `body.metadata.disabledGuardrails`, and `x-omniroute-disabled-guardrails` headers with **no allowlist / per-key gate**. Any caller with a valid API key can add `"disabledGuardrails":["prompt-injection","pii-masker"]` and skip operator-mandated guardrails for that request. Gate client-side disabling behind a per-API-key opt-in flag.

#### M2 — `server.env` secrets file written world-readable **[FIXED ✅]**

`scripts/build/bootstrap-env.mjs:147`, `electron/main.js:608` wrote `{DATA_DIR}/server.env` (holding `STORAGE_ENCRYPTION_KEY`, `JWT_SECRET`, `API_KEY_SECRET`) with no `mode` → `0644` on a typical umask. On a multi-user host any local user could read the **master encryption key** and defeat all at-rest credential encryption.
**Fix:** write with `{ mode: 0o600 }` + explicit `chmod 600` (tightens a pre-existing loose file too). Regression tests added.

#### M3 — DNS-rebinding to the cloud-metadata endpoint in `block-metadata` mode **[OPEN]**

`src/shared/network/outboundUrlGuard.ts:164` — in the default provider-validation mode only the hostname **string** is checked against known metadata names; the resolve-then-reject rebinding guard that protects `public-only` is skipped. A provider base URL of `http://rebind.attacker.com/v1` resolving to `169.254.169.254` passes the string check and the validation fetch hits IMDS. Management-gated (caps severity), impact high (IAM creds). Run the A/AAAA-resolution metadata check in `block-metadata` mode too, or pin the connection to the validated IP.

#### M4 — Raw `error.message` leaked on unauthenticated dashboard routes **[assess FIXED ✅ / db-health OPEN]**

`src/app/api/assess/route.ts:99` returned `error.message` verbatim (Hard Rule #12 violation); `src/app/api/db/health/route.ts` returns raw DB error strings. Fully unauthenticated when `requireLogin=false`.
**Fix (assess):** route through `sanitizeErrorMessage()`, log detail server-side. **Also fixed a latent bug in the same file** (see B1). `db/health` remains to be routed through `createErrorResponse()`.

#### M5 — OmniRoute-issued API keys stored plaintext at rest **[OPEN]**

`src/lib/db/apiKeys.ts` keeps the raw `sk-…` in `api_keys.key` alongside the SHA-256 hash (to support the "reveal key" feature). Provider credentials get AES-256-GCM; these client keys don't. A read of the SQLite file / a stolen backup yields usable proxy keys with no cracking. Consider hash-only storage (reveal via re-derivation) or document the tradeoff. _Validation itself is sound — hashed lookup, not a timing-vulnerable `===`._

#### M6 — Traffic-inspector returns upstream response headers unmasked **[OPEN]**

`src/mitm/inspector/agentBridgeHook.ts:112` stores `responseHeaders` without `sanitizeHeaders()`, and `src/mitm/sanitizeHeaders.ts` omits `set-cookie` from its mask list. Secret-bearing upstream headers (`Set-Cookie`, `Authorization`) can appear verbatim in dashboard JSON. One-line fix: route line 112 through `sanitizeHeaders()` and add `set-cookie` to the mask set.

#### M7 — Cloud-sync HMAC verification fails open when the secret is unset **[OPEN]**

`src/lib/cloudSync.ts:47` — if `OMNIROUTE_CLOUD_SYNC_SECRET` is unset but a response carries `X-Cloud-Sig`, verification returns `true` without verifying (documented back-compat, "enforce-by-default flips in v3.9"). With `CLOUD_URL` configured but no shared secret, a MITM/malicious endpoint can inject providers/tokens. Flip to fail-closed.

#### M8 — vm-executed middleware hooks are not loopback-gated **[OPEN]**

`src/app/api/middleware/hooks/route.ts` compiles arbitrary JS via `new vm.Script` and runs it on the request hot path, but `/api/middleware/` is **not** in `LOCAL_ONLY_API_PREFIXES` — unlike the functionally-identical `/api/plugins/` code-exec surface, which **is** loopback-gated (Hard Rules #15/#17). With auth disabled + LAN/tunnel exposure, a remote client could register a hook that rewrites every in-flight request. _Mitigated:_ the sandbox is capability-free with `codeGeneration:{strings:false,wasm:false}` + 5s timeout. Add `/api/middleware/` to `LOCAL_ONLY_API_PREFIXES` for parity.

#### M9 — `requireLogin=false` collapses the management auth tier **[OPEN / by-design footgun]**

`src/server/authz/policies/management.ts:224` — with auth disabled (a documented local-first default) every MANAGEMENT route except the `ALWAYS_PROTECTED` set becomes anonymous. Safe on localhost; dangerous if such an instance is tunnel-exposed. The loopback gate still runs first, so spawn-capable routes stay loopback-only. Document prominently; consider refusing `requireLogin=false` on a non-loopback bind.

### LOW / Informational (condensed)

| #   | Item                                                                                                                                                     | Location                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| L1  | Field-encryption stores plaintext if `STORAGE_ENCRYPTION_KEY` unset on the instrumentation launch path (bootstrap generates it; instrumentation doesn't) | `src/lib/db/encryption.ts:123`, `src/instrumentation-node.ts` |
| L2  | `STORAGE_ENCRYPTION_KEY` not length/strength-validated                                                                                                   | `src/shared/utils/secretsValidator.ts`                        |
| L3  | scrypt uses a static salt (`"omniroute-field-encryption-v1"`) — acceptable for a high-entropy key, per-install salt would be stronger                    | `src/lib/db/encryption.ts:41`                                 |
| L4  | Env master key compared with raw `===` (timing) — per-user key path is a hashed lookup, unaffected                                                       | `src/lib/db/apiKeys.ts:223`                                   |
| L5  | `jwtVerify` callsites omit explicit `algorithms:['HS256']` (not exploitable — jose rejects `alg:none`, symmetric key) — defense-in-depth                 | `src/shared/utils/apiAuth.ts:241` et al.                      |
| L6  | Weak random component in generated API keys + no failed-auth throttle                                                                                    | `src/shared/utils/apiKey.ts`, `apiKeyPolicy.ts`               |
| L7  | Second, weaker hand-rolled `isPrivateHost` (omits CGNAT / IPv6 ULA) — delegate to canonical guard                                                        | `src/lib/db/upstreamProxy.ts:36`                              |
| L8  | Acknowledged TOCTOU residual in `public-only` DNS-rebinding guards (closable by IP-pinning via undici)                                                   | `src/shared/network/remoteImageFetch.ts:52`                   |
| L9  | Raw `error.message`/`String(error)` cluster in dashboard/MCP/A2A/tunnel routes (internal messages, no stacks)                                            | many                                                          |
| L10 | Plugin worker allows plugin-authored FS paths to escape `pluginDir`; opt-in `child_process` — by-design (LOCAL_ONLY, local-trusted)                      | `src/lib/plugins/pluginWorker.ts:110`                         |
| L11 | ACP custom-agent version probe uses `shell:true` (management-gated config only)                                                                          | `src/lib/acp/registry.ts:320`                                 |
| L12 | DuckDuckGo challenge solver runs upstream JS in an empty-context vm (documented, sandboxed, 5s timeout)                                                  | `open-sse/executors/duckduckgo-web/challenge.ts:112`          |
| L13 | `consoleInterceptor` writes console args to the log file without masking (latent — no raw-secret `console.*` today)                                      | `src/lib/consoleInterceptor.ts:56`                            |
| L14 | `tls-client-node` postinstall downloads a native binary from GitHub releases without a checksum (optional dep, standard native pattern)                  | dependency                                                    |
| L15 | `@types/bun: "latest"` floating pin (dev-only, types-only)                                                                                               | `package.json:313`                                            |

---

## 5. Fixes Implemented This Session

All three ship with regression tests; `typecheck:core` clean, `lint` clean, existing cloud-agent tests 24/24, new tests green.

| Finding                                 | Change                                                                                                                   | Test                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **H1** CORS credential theft            | `src/lib/cloudAgent/api.ts` — fail-closed via `resolveAllowedOrigin`; credentials only for allowlisted origins           | `tests/unit/security/cloud-agent-cors-failclosed.test.ts` (5) |
| **M2** world-readable secrets file      | `scripts/build/bootstrap-env.mjs`, `electron/main.js` — write `mode 0o600` + `chmod`                                     | `tests/unit/bootstrap-env.test.ts` (+2)                       |
| **M4** raw error leak + **B1** env typo | `src/app/api/assess/route.ts` — `sanitizeErrorMessage()`; fixed `OMNIROUTe_API_KEY`/`OMNIROUTe_BASE_URL` → `OMNIROUTE_*` | `tests/unit/security/assess-error-sanitization.test.ts` (1)   |

### B1 — Latent bug fixed: misspelled env vars in the assessment route

`src/app/api/assess/route.ts` referenced `process.env.OMNIROUTe_API_KEY` and `OMNIROUTe_BASE_URL` (lowercase `e`) in three places. These never match the documented `OMNIROUTE_API_KEY` / `OMNIROUTE_BASE_URL` (`.env.example:619,622`, `src/types/global.d.ts:27`), so the assessor silently ignored the operator's configured key/base URL and always fell back to `API_KEY`/localhost. Corrected all three occurrences.

---

## 6. Strong Security Practices Verified (do not regress)

- **AES-256-GCM at rest done right** (`src/lib/db/encryption.ts`): fresh random IV per op, auth tag verified on decrypt, `authTagLength:16` pinned (rejects tag truncation), scrypt KDF, no ECB/static-IV, no silent weak-key fallback.
- **All security randomness uses `node:crypto`** — PKCE `randomBytes(32)`+S256, API keys `randomBytes`+pbkdf2, relay tokens hashed. `Math.random()` only in jitter/routing/IDs.
- **SSRF surface locked down:** canonical `outboundUrlGuard` blocks loopback/RFC1918/CGNAT `100.64/10`/IPv6 ULA+link-local and **all of `169.254.0.0/16` unconditionally**; client-supplied image URLs held to strict `public-only` + DNS-rebinding checks + per-hop redirect re-validation + size caps; **provider base URLs are NOT client-controllable per-request** (read from DB config, management-gated).
- **Authorization: loopback-enforced-before-auth from an unspoofable source** — locality comes from a token-stamped real-TCP-peer-IP header (never the `Host` header), `timingSafeEqual`-verified, fail-closed. `X-Forwarded-For`/`Host: localhost` cannot spoof loopback. `LOCAL_ONLY_API_PREFIXES` covers every process-spawning route found (except the middleware-hooks gap, M8).
- **No client-auth leakage upstream** — the inbound OmniRoute `Authorization` is never forwarded; outbound auth is rebuilt from the provider's own credentials; operator custom headers pass an `isForbiddenCustomHeaderName` denylist (blocks `authorization`, `cookie`, `x-api-key`, CR/LF/NUL injection).
- **Error sanitization** (`open-sse/utils/error.ts`) — `sanitizeErrorMessage` (tokenized, strips paths/stack), `buildErrorBody`, `sanitizeUpstreamDetails`; no `.stack` reaches any v1 response body.
- **JWT via `jose`** (rejects `alg:none`, symmetric secret → no confusion), **bcrypt cost-12** admin password, **CSRF** HMAC-SHA256 + `timingSafeEqual`, **layered log redaction** (pino redact + `maskKey`/`maskSecret` + HAR export masking).
- **SQL fully parameterized** — zero value-interpolation matches; identifier interpolation is union-literal-typed constants only. **No `eval`/`new Function`.** **Electron hardened** (`contextIsolation:true`, `nodeIntegration:false`, `webSecurity:true`).

---

## 7. Live Provider-Key Testing — Environment Constraint

Three provider keys were supplied (OpenAI, OpenRouter, Z.ai/GLM). **This session's egress policy blocks all outbound provider hosts** — `api.openai.com`, `openrouter.ai`, and `api.z.ai` each return a proxy `connect_rejected` (403). Per the environment's proxy contract, blocked hosts are reported, not routed around. **Live upstream calls with the real keys are therefore not possible from this environment**, and OmniRoute's own outbound calls (e.g. Arena leaderboard sync) fail the same way.

What was validated instead: the full OmniRoute request pipeline on the live server (routing, Zod validation, provider resolution, error sanitization, health, CORS) plus the 232-test suite that covers the executor/translator success paths. To validate the keys against real providers, run OmniRoute from an unrestricted network and add the connections via the dashboard (Providers → add OpenAI / OpenRouter / Z.ai key) or `POST /api/providers`. **The keys were not written to any committed file** (Hard Rule #1).

---

## 8. Optimization & Enhancement Opportunities

1. **Dev-server resilience to missing optional deps (high value, low effort).** A missing optional dep (`@huggingface/transformers`) makes Turbopack dev 500 every route. Options: mark it `noExternal`/aliased-to-a-stub in dev, or add a documented dev fallback so `npm run dev` works without the heavy ML optionals installed. Production is fine (lazy import); this is purely DX.
2. **Health endpoint does 8 dynamic `import()`s via `Promise.allSettled` on every call** (`src/app/api/monitoring/health/route.ts:37`). These modules are stable after first load; memoizing the module refs (or the whole payload with a short TTL) trims per-request work on a frequently-polled endpoint.
3. **Consolidate the two `isPrivateHost` implementations** (L7) — the weaker `upstreamProxy.ts` copy should delegate to the canonical `outboundUrlGuard`, removing drift risk.
4. **Pin `@types/bun` off `latest`** (L15) to a semver range for reproducible installs.
5. **Route the remaining raw-error clusters** (M4 db/health, L9) through `createErrorResponse()` to fully close Hard Rule #12 and reduce future CodeQL noise.
6. **Guardrail-override policy bit** (M1) — turning a hot-path merge into a per-key opt-in is both a security fix and a cleaner API contract.
7. **`onnxruntime-node` binary source** — its postinstall fetches a GPU binary from GitHub; consider the CPU-only build or a checksum-verified mirror to make installs deterministic in restricted networks.

---

## 9. Prioritized Next Steps

1. **H2** — refuse to start / force rotation when `INITIAL_PASSWORD=CHANGEME` on a non-loopback bind.
2. **M1** — gate client-side guardrail disabling behind a per-API-key flag.
3. **M3** — DNS-resolution metadata check (or IP pinning) in `block-metadata` mode.
4. **M6 / M7** — `sanitizeHeaders()` + `set-cookie` on the inspector response path; flip cloud-sync HMAC to fail-closed.
5. **M8** — add `/api/middleware/` to `LOCAL_ONLY_API_PREFIXES`.
6. **M5** — decide hash-only key storage vs. documenting the reveal-feature tradeoff.
7. Sweep the Low items (L1–L15) opportunistically.

_Fixes delivered this session (H1, M2, M4, B1) are committed on this branch with passing regression tests._
