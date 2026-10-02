# Native Bridge production acceptance

Owner: Jillur Rahman / NexaLance

The frozen acceptance record is `production-acceptance-2026-10-02.json`. The full Bengali handoff is `../docs/AGENT-BRIDGE-PRODUCTION-HANDOFF-2026-10-02.md`. These record the tested code build and explicit provider/feature limitations; they are not a promise about future vendor versions.

Run package and live gates before native testing:

```sh
node nexa/deploy/bridge-gate.mjs package /absolute/path/to/verified-package.tgz
node nexa/deploy/bridge-gate.mjs live
```

To exercise native concurrency after a gateway or Claude CLI update:

```sh
node nexa/qa/native-concurrency.mjs --live --output-dir /absolute/path/to/a-new-private-directory
```

This makes real requests using the existing native first-party login. It consumes provider quota. It creates four synthetic conversations, resumes each separately, then cancels one stream while three others finish. A native result event, expected text, separate context markers and unchanged Bridge PID are required. Read the summary file and each failed result; an exit code alone is not sufficient evidence. Model IDs are explicit in the script; an unavailable model must be reported, not silently substituted.

The output directory must be fresh. Private output files are written with mode 0600 and the directory with mode 0700. No user project files are read or changed, no native account/settings are changed, and no provider credentials are copied. Do not commit output logs or credentials. Additional account rotation, Desktop UI tools, scheduled execution and new native protocol headers require their own actual acceptance tests.

Use the managed dashboard update or `omni-ctl update`. It checks overlays, measured typecheck gates, regressions, packaged source/compiled contracts and isolated authenticated smoke before promotion. Live TLS checks and complete prefix/database recovery protect the installed service. Keep verified rollback packages and database snapshots. Updates and restarts can interrupt active requests; use an idle window for actual promotion.
