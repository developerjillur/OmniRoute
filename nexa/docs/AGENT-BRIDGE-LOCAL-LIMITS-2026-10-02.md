# Local request limits and native thread error handling

Owner: Jillur Rahman
Date: 2026-10-02

The native previous_message_id 404 is request-scoped. Excluding its healthy connection can leave only a near-exhaustion connection, producing a misleading cached-quota response without another upstream attempt. Recognize the exact bounded native error as a request-resource 404; preserve it for client replay without account/model cooldown or fallback. Model and endpoint 404 handling remains unchanged.

The dashboard request-queue editor submits globalConcurrentRequests, but the strict resilience requestQueue schema omitted it. Register its existing normalized range (0..100000) so disabling automatic queue activation saves successfully. Zero disables the global concurrency cap; invalid negative and excessive values remain rejected.

Browser configuration: connected account quota-window reserve cutoffs set to zero, Claude connection Disable cooldown enabled, quota-share concurrency enforcement disabled. Account rate-limit protection is off and no explicit account Max Concurrent cap is configured. Global quota preflight, model lockout, provider cooldown and global concurrency are disabled. Queue auto-enable must be saved and re-read after deploying the schema fix. Provider-enforced quotas and actual exhausted-state handling remain distinct from local reserve thresholds. Paid extra usage remains blocked.

Focused verification: 49 tests passed across local limit settings, error classification and SSE resource-404 account-health tests. Both fixes and their regression test live exclusively in the nexa overlay. Build/deploy uses the existing guarded updater, with isolated package tests and rollback preservation. Future releases require patch compatibility checks and native routing verification; no unconditional future compatibility guarantee is made.
