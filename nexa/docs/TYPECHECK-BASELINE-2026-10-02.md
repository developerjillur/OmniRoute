# TypeScript baseline reconciliation, 2026-10-02

Owner: Jillur Rahman / NexaLance

The previous full-scope error budget was measured at v3.8.45 (3014 diagnostics), while this fork runs v3.8.51. A fresh pristine worktree at upstream-main c1e30b767 reports 5875 full-scope diagnostics with Node 24.15.0 and the installed dependency tree. The applied v3.8.51 overlay reports 5830. The new Bridge transport tests, runtime state, recovery and inspector stream files report zero diagnostics. The separate typecheck:core gate passes.

The budget is reconciled to the measured applied count, 5830, with an explicit upstream comparison. This is an inherited full-scope backlog, not a claim that the entire repository typechecks without errors. The check remains a down-only ratchet; a future count above the measured budget blocks deployment, and an unmeasured/SKIP gate is rejected by the updater.

Exclude nexa from the application compiler: it contains source templates copied into their real paths by the overlay and must not be checked twice. The emitted runtime is unchanged by this compiler-scope correction.

Evidence: private local pristine-v3.8.51-tsc.log, applied-v3.8.51-tsc.log and nexalance-node24-core.log. Production build and package inspection are independent acceptance gates.
