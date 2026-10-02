import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const files = [];
for (const [directory, pattern] of [
  ["tests/unit", /^(mitm-|agent-bridge-|db-agent-bridge).*\.test\.(ts|mjs)$/],
  ["tests/integration", /^agent-bridge-.*\.test\.ts$/],
]) {
  for (const name of fs.readdirSync(directory)) {
    if (pattern.test(name)) files.push(path.join(directory, name));
  }
}
if (!files.some((file) => file.endsWith("agent-bridge-legacy-claude-thinking.test.ts"))) {
  throw new Error("Native legacy-Claude thinking suite is missing");
}
if (!files.some((file) => file.endsWith("agent-bridge-resilience.test.ts"))) {
  throw new Error("Native Bridge resilience suite is missing");
}
if (!files.some((file) => file.endsWith("agent-bridge-thread-cache.test.ts"))) {
  throw new Error("Native thread cache-budget suite is missing");
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-regression-data-"));
console.log(`Bridge regression: ${files.length} files, serial execution, isolated data directory`);
const result = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", "--test", "--test-concurrency=1", ...files.sort()],
  {
    stdio: "inherit",
    env: { ...process.env, DATA_DIR: dataDir, MITM_AUTO_RECOVER: "false" },
  }
);
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const ui = fs
    .readdirSync("tests/unit/ui")
    .filter((name) => /^(agent-bridge-|mitm-proxy-).*\.test\.tsx$/.test(name))
    .map((name) => path.join("tests/unit/ui", name));
  const checked = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.config.ts",
      "--maxWorkers",
      "2",
      ...ui,
    ],
    { stdio: "inherit", env: { ...process.env, DATA_DIR: dataDir, MITM_AUTO_RECOVER: "false" } }
  );
  process.exitCode = checked.status ?? 1;
}
