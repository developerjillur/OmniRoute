import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvironment, descendantRss, runBounded } from "./run-bounded-build.mjs";

test("build defaults replace an inherited large heap without dropping other options", () => {
  const env = buildEnvironment({
    NODE_OPTIONS: "--require=/tmp/shim.cjs --max-old-space-size=16384",
  });
  assert.equal(env.NODE_OPTIONS, "--require=/tmp/shim.cjs --max-old-space-size=5120");
  assert.equal(env.NEXA_BUILD_WORKERS, "1");
  assert.equal(env.OMNIROUTE_USE_TURBOPACK, "0");
  assert.throws(() => buildEnvironment({ NEXA_BUILD_WORKERS: "13" }));
});
test("memory accounting includes nested build children but excludes other apps", () => {
  assert.equal(descendantRss("10 1 30\n12 11 40\n11 10 50\n99 1 999999", 10), 120 * 1024);
});
test("successful commands keep their real exit status", async () => {
  const result = await runBounded(process.execPath, ["-e", "process.exit(7)"], { limitMiB: 512 });
  assert.equal(result.code, 7);
  assert.equal(result.stopped, false);
});
test("a real allocating child is stopped when its process group exceeds the budget", async () => {
  const result = await runBounded(
    process.execPath,
    ["-e", "const b=Buffer.alloc(180*1024*1024,1); setInterval(()=>b[0]++,100)"],
    { limitMiB: 120, intervalMs: 100 }
  );
  assert.equal(result.code, 75);
  assert.equal(result.stopped, true);
  assert.match(result.reason, /RSS budget exceeded/);
});
