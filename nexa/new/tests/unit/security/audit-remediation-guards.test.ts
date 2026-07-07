/**
 * SECURITY_AUDIT regression tests — part 2 (guards/config):
 * H2 (CHANGEME public-bind refusal), M2 (server.env 0600), M8 (middleware
 * loopback-gate), M4 (db/health error sanitization). Complements
 * audit-remediation.test.ts (M1/M3/M6/M7).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { evaluatePublicBindSafety } = await import("../../../scripts/build/startupGuard.mjs");
const { writeEnvFile } = await import("../../../scripts/build/bootstrap-env.mjs");
const { LOCAL_ONLY_API_PREFIXES } = await import("../../../src/server/authz/routeGuard.ts");

// ── H2 + #19: startup guard refuses insecure public prod binds ───────────────
test("H2/guard: refuses a public prod bind with the default CHANGEME password", () => {
  const r = evaluatePublicBindSafety({
    NODE_ENV: "production",
    HOSTNAME: "0.0.0.0",
    REQUIRE_API_KEY: "true", // key enforcement on, so ONLY the password triggers
    INITIAL_PASSWORD: "CHANGEME",
  });
  assert.equal(r.refuse, true);
  assert.match(r.reason, /CHANGEME|default dashboard password/);
});

test("H2/guard: refuses a public prod bind with REQUIRE_API_KEY off", () => {
  const r = evaluatePublicBindSafety({ NODE_ENV: "production", HOSTNAME: "0.0.0.0" });
  assert.equal(r.refuse, true);
  assert.match(r.reason, /REQUIRE_API_KEY/);
});

test("H2/guard: ALLOWS loopback / dev / explicit-override / enforced+strong-password", () => {
  const allow = [
    { NODE_ENV: "production", HOSTNAME: "127.0.0.1", INITIAL_PASSWORD: "CHANGEME" }, // loopback
    { NODE_ENV: "development", HOSTNAME: "0.0.0.0" }, // not prod
    { NODE_ENV: "production", HOSTNAME: "0.0.0.0", OMNIROUTE_ALLOW_INSECURE_PUBLIC: "true" }, // override
    { NODE_ENV: "production", HOSTNAME: "0.0.0.0", REQUIRE_API_KEY: "true", INITIAL_PASSWORD: "s3cret!" }, // safe
  ];
  for (const env of allow) {
    assert.equal(evaluatePublicBindSafety(env).refuse, false, JSON.stringify(env));
  }
});

// ── M2: server.env / .env written 0600 ──────────────────────────────────────
test("M2: writeEnvFile creates the secrets file with 0600 permissions", () => {
  const f = join(tmpdir(), `omni-sec-m2-${process.pid}-${Math.floor(process.hrtime()[1])}.env`);
  try {
    writeEnvFile(f, { STORAGE_ENCRYPTION_KEY: "x", JWT_SECRET: "y" });
    const mode = statSync(f).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
    assert.ok(readFileSync(f, "utf8").includes("STORAGE_ENCRYPTION_KEY=x"));
  } finally {
    try {
      rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

// ── M8: /api/middleware/ is loopback-gated (parity with /api/plugins/) ────────
test("M8: LOCAL_ONLY_API_PREFIXES includes /api/middleware/ (vm code-exec surface)", () => {
  assert.ok(
    LOCAL_ONLY_API_PREFIXES.includes("/api/middleware/"),
    "middleware hooks (new vm.Script) must be loopback-gated like /api/plugins/"
  );
});

// ── M4: db/health error paths route through sanitizeErrorMessage ──────────────
test("M4: db/health route sanitizes error messages (Hard Rule #12)", () => {
  const src = readFileSync(
    new URL("../../../src/app/api/db/health/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /import\s*\{\s*sanitizeErrorMessage\s*\}/, "must import the sanitizer");
  const returns = src.match(/status:\s*500/g) || [];
  const sanitized = src.match(/sanitizeErrorMessage\(message\)/g) || [];
  assert.ok(sanitized.length >= returns.length && sanitized.length >= 2,
    "every 500 error path must wrap the message in sanitizeErrorMessage");
});
