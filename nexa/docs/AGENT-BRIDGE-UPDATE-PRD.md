# Native Agent Bridge update durability

Owner: Jillur Rahman / NexaLance

## Problem

The local 3.8.51 runtime needed native transport fixes after installation. The source build and rollback archives did not include those fixes. Updating could preserve the database and still replace the working Bridge with an incompatible listener.

## Required behavior

- Keep the upstream base pristine and store changes as build-time overlay patches.
- Preserve native model IDs, effort fields, session headers, query parameters and compressed request bodies.
- Return the router's actual status, content type, request ID and retry headers for JSON, SSE and errors.
- Bind the Bridge to the configured loopback port and select the owner of a shared target host explicitly.
- Provision only enabled agents when selected-only mode is configured.
- Persist explicit Start/Stop intent. Recover enabled listeners after service restart without installing a new CA or adding unapproved DNS entries.
- Show actual listener counters and current certificate trust in the dashboard.
- Provide an authenticated local HTTP event stream where the production App Router cannot expose a raw WebSocket socket.
- Build in isolation. Verify the packaged Bridge and the rollback package before stopping the service.
- Verify the actual backend and native TLS ingress after installation; service health alone cannot accept a deployment.
- Keep provider credentials, database, encryption key, certificates and native account/history outside replaceable package files.

## Validation

Synthetic transport fixtures reproduce the original shared-host failure before the change. The fixed fixture covers JSON, SSE, 429, request headers/query, model/effort preservation and gzip/deflate/br/zstd with certificate verification enabled. Runtime-state tests cover counters and persistent Stop intent. Event-stream tests cover snapshot/update and cleanup. Package inspection, isolated smoke, live inference, cold restart and failed-deployment rollback are separate acceptance gates; evidence must record each result.

## Limits

No finite gate can guarantee every future vendor protocol or identical model output quality. New models require supported provider routing. Cloud routines remain tied to their execution account. Additional OAuth accounts require the owner to complete their normal sign-in; credentials must never be copied into this repository.

The previous nginx ingress depended on Local being open and caused native login to fail after reboot. A dedicated macOS LaunchDaemon now forwards only encrypted bytes from IPv4/IPv6 loopback port 443 to the Bridge on 8443, dropping to nobody after binding. It does not own a certificate or decrypt traffic. If the local listener is unavailable, it can resolve the original vendor with public DNS and forward the untouched TLS connection directly. Native quota remains relevant during that fallback window.

The local readiness and Bridge socket windows are 600 seconds. A verified log showed a long Opus request cut off by the former 95-second content readiness watchdog. The longer window preserves normal fast responses while giving long reasoning more time; it does not guarantee availability when the provider itself fails.

The updater preserves existing archives, uses isolated worktrees and out-of-band package smoke, rejects unmeasured TypeScript gates, and checks both native ingress and backend TLS. An interrupted update lock is recoverable. Desktop rebuild remains best effort and preserves the last working shell. Source deployment tools are versioned under nexa/deploy; the installed command must prefer these over the older portable kit script.

## Accepted package gates

Production standalone build, package policy and source/dist Bridge equality passed. Isolated package smoke passed management authentication, configured port 8443, catalog authentication, a real Opus message and browser CORS isolation. Bridge/security regression gate: 54 tests; broader Bridge tests: 315; service Vitest: 493. Core typecheck passed. Full-scope ratchet uses the documented inherited v3.8.51 baseline, not a zero-error claim.

Deployment promotes the installed isolated prefix atomically after preserving runtime extras and the whole previous prefix. Rollback renames that exact prior prefix back into place. Native TLS ingress, explicit Start/Stop, cold service restart and fault-injected rollback must be verified on the live machine independently.

Generic transport proposal: https://github.com/diegosouzapw/OmniRoute/pull/15323 (draft). Local macOS ingress/recovery/update policy remains in this fork.

## Live acceptance on 2026-10-02

A native Opus request with low effort and a native Sonnet request with high effort both returned the expected marker through the installed Bridge, using first-party Max login without API-base overrides. Service restart recovered the enabled listener. Dashboard Stop persisted false and survived a further service restart. With no cached administrator password, hosts entries remain; the independent loopback ingress forwards untouched TLS directly to Anthropic while the listener is stopped. A no-credential native HTTPS request reached Anthropic with certificate validation enabled and received the expected 401. Dashboard Start restored the preserved mappings.

The first candidate was rejected because the CLI port preflight treated an IDE client connection as a listener. Restricting POSIX discovery to TCP LISTEN sockets fixes that false positive; its regression fails before the change and passes after. All 16 preflight tests pass. The corrected archive was smoked out of band before promotion.

A fault archive deliberately returned an invalid native transport health response. The updater rejected it and restored the complete previous runtime; both native ingress and backend TLS passed afterwards. Rollback also restores the consistent pre-deployment SQLite snapshot after closing the service, retaining the post-deployment database and WAL files. A future-schema fixture verifies the old schema and configuration are recovered without deleting the failed migration evidence.

The dedicated macOS ingress installer has run on the machine. LaunchDaemon RunAtLoad/KeepAlive and LaunchAgent recovery are configured; a further full Mac reboot after the new build was not performed during this acceptance run. Two active Claude OAuth connections were observed during final configuration review; the third connection remains an owner sign-in step.

Ingress selection is limited to the public TLS ClientHello hostname: only api.anthropic.com enters the Claude Bridge. Other loopback hostnames retain the Local wildcard router through 127.0.0.2:443. Fixtures cover fragmented TCP/TLS ClientHello, a 1 MiB unchanged stream, direct vendor fallback, exclusion of other hosts, IPv4/IPv6 binds and macOS wildcard coexistence. No HTTP payload or credential is parsed by the forwarder.
