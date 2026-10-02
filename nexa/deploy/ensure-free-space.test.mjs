import test from "node:test";
import assert from "node:assert/strict";
import { ensureFreeSpace } from "./ensure-free-space.mjs";

const GiB = 1024 ** 3;
const measured = (free) => () => ({ bsize: 4096, bavail: (free * GiB) / 4096 });

test("source build requires enough space without invoking a build", () => {
  assert.throws(() => ensureFreeSpace("/fixture", "build", measured(23)), /live service untouched/);
  assert.equal(ensureFreeSpace("/fixture", "build", measured(24)).requiredBytes, 24 * GiB);
});

test("install has its own lower budget and does not accept a full filesystem", () => {
  assert.throws(() => ensureFreeSpace("/fixture", "install", measured(0)), /6 GiB required/);
  assert.equal(ensureFreeSpace("/fixture", "install", measured(6)).ok, true);
});

test("unknown phase and invalid filesystem measurements fail closed", () => {
  assert.throws(() => ensureFreeSpace("/fixture", "typo", measured(100)), /Unknown/);
  assert.throws(() => ensureFreeSpace("/fixture", "build", () => ({ bsize: NaN })), /unknown/);
});
