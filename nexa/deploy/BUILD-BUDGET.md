# Managed build resource budget

The managed updater and `node nexa/build.mjs` use `run-bounded-build.mjs`.
This controls the build process tree; it does not change the running gateway's
memory settings or the user's other applications.

Defaults:

| Setting | Value |
| --- | --- |
| Node old-space heap per process | 6144 MiB |
| Next build workers | 1 |
| Total observed build-tree RSS budget | 8192 MiB |
| Memory sampling interval | 1 second |
| Scheduling priority | nice +10 |
| Next bundler | Webpack; parallelism 8, compile cache disabled |
| macOS build toolchain | /usr/local/bin first in PATH |
| UV thread pool | 2 |
| Regression execution | Serial; UI maxWorkers 1 |

The wrapper replaces inherited large `--max-old-space-size` values while keeping
other Node options. `NEXA_BUILD_HEAP_MB` accepts 1024 through 6144 and
`NEXA_BUILD_WORKERS` accepts 1 or 2. `NEXA_BUILD_RSS_MB` sets the process-tree
watchdog budget. Changing the budget is an explicit operator choice.

This is a polling watchdog, not an operating-system hard memory limit. Brief
spikes between samples remain possible. An over-budget build exits with code 75
after terminating its own process group. The updater stops before promotion and
keeps the live runtime intact. Other sessions must not be killed by name or port.

The 2026-10-02 validation measured approximately 4.9 GiB peak RSS during the
initial typecheck/ratchet run. A deliberate allocating-child test verified that
the watchdog terminates an over-budget process. A 5 GiB production attempt exhausted its heap at 5162 MiB observed RSS.
A separate 6 GiB retry inherited Node 26 from the shell and also exhausted its
heap. Managed macOS builds now consistently prefer the installed Node 24
toolchain, disable unused compilation cache, and limit module parallelism to 8.
A successful complete production build under this revised profile is still required.

`build-candidate.sh` preserves the existing typecheck, ratchet, Bridge, UI,
security, artifact, and packaging gates. The updater still requires an isolated
real Claude completion before promotion. Subscription exhaustion is not a reason
to skip that gate or to enable paid extra usage.

Source files outside `nexa/` must remain pristine for the updater. Existing
uncommitted source work from another session is never discarded automatically.
An update will stop at the dirty-tree guard until its owner reconciles that work.

## Storage

Settings changes do not need a build or runtime backup. Package deployment keeps
the current package and the immediate rollback package/runtime. Old generated
artifacts may be removed only after checking the exact paths against the
`current`, `previous`, and `previous-runtime` references. Project files, user
history, credentials, failed-deployment evidence, and external-drive contents
are not automatic cleanup targets.

On 2026-10-02 the obsolete 43bc71075 package, its 20261002-150336 runtime copy,
and completed smoke-20261002-211555 residue were removed after that check.
Approximately 2.7 GB of generated data was reclaimed. Current 0bda6c400 and
immediate rollback f002e7654 archives, rollback runtime, and desktop backup were
retained.
