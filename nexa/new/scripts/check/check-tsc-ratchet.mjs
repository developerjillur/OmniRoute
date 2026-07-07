#!/usr/bin/env node
// scripts/check/check-tsc-ratchet.mjs
// TypeScript-error ratchet — the report-accepted "tracked exception" for
// `next.config.mjs typescript.ignoreBuildErrors: true`. The production build
// still ignores TS errors (a full flip is a 2966-error / 620-file backlog), but
// this gate makes the backlog MONOTONICALLY BURN DOWN: new code may not add TS
// errors, and the count can only ratchet down.
//
// Output (stdout):
//   tscErrors=N                         — measured `tsc --noEmit` error count
//   tscErrors=SKIP reason=tsc-absent    — tsc could not run (never blocks)
//
// Advisory by default (always exit 0). With --ratchet it BLOCKS (exit 1) if — and
// only if — the measured count is GREATER than the baseline in
// config/quality/tsc-error-baseline.json (a real regression). A measurement
// failure (tsc missing, crash) exits 0 even with --ratchet — only a measured
// regression blocks. When the measured count DROPS below baseline, run with
// --update to tighten the baseline (never widen it by hand without justification).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const QUIET = process.argv.includes("--quiet");
const RATCHET = process.argv.includes("--ratchet");
const UPDATE = process.argv.includes("--update");
const BASELINE_PATH = path.join(ROOT, "config/quality/tsc-error-baseline.json");

function log(msg) {
  if (!QUIET) process.stderr.write(`${msg}\n`);
}

/** Count `error TS####:` lines in tsc output. Exported shape for testing. */
export function countTscErrors(tscStdout) {
  const matches = String(tscStdout).match(/error TS\d+:/g);
  return matches ? matches.length : 0;
}

function measure() {
  // Reuse the repo's tsconfig (same config the build would type-check against).
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.json"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.error || res.status === null) {
    return { skip: true, reason: "tsc-absent" };
  }
  // tsc exits non-zero when there are errors; that is expected — we parse stdout.
  return { skip: false, count: countTscErrors(`${res.stdout || ""}${res.stderr || ""}`) };
}

function readBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    return typeof raw.value === "number" ? raw.value : null;
  } catch {
    return null;
  }
}

const result = measure();
if (result.skip) {
  process.stdout.write(`tscErrors=SKIP reason=${result.reason}\n`);
  process.exit(0); // a measurement failure NEVER blocks
}

const measured = result.count;
const baseline = readBaseline();
process.stdout.write(`tscErrors=${measured}\n`);
log(`[tsc-ratchet] measured=${measured} baseline=${baseline ?? "none"}`);

if (UPDATE) {
  if (baseline !== null && measured > baseline) {
    log(`[tsc-ratchet] refusing --update: measured ${measured} > baseline ${baseline} (never widen).`);
    process.exit(1);
  }
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          "TypeScript-error ratchet baseline. direction: down (can only shrink). Update via `npm run check:tsc-ratchet -- --update` ONLY when the measured count drops. Owner: OmniRoute maintainers. Removal target: reach 0, then re-enable next.config typescript.ignoreBuildErrors:false.",
        value: measured,
        direction: "down",
      },
      null,
      2
    ) + "\n"
  );
  log(`[tsc-ratchet] baseline updated → ${measured}`);
  process.exit(0);
}

if (RATCHET && baseline !== null && measured > baseline) {
  log(
    `[tsc-ratchet] REGRESSION: ${measured} TS errors > baseline ${baseline}. New code must not add TS errors.`
  );
  process.exit(1);
}
process.exit(0);
