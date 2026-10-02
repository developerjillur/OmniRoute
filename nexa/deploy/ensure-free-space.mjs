import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GiB = 1024 ** 3;
const budgets = Object.freeze({ build: 24 * GiB, install: 6 * GiB });

export function ensureFreeSpace(directory, phase, measure = fs.statfsSync) {
  const required = budgets[phase];
  if (!required) throw new Error("Unknown update storage phase");
  const stat = measure(directory);
  const available = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isFinite(available) || available < required) {
    const free = Number.isFinite(available) ? (available / GiB).toFixed(1) : "unknown";
    throw new Error(
      `Insufficient free disk space for ${phase}: ${free} GiB available; ${required / GiB} GiB required. Preserve old generated builds before reclaiming space; live service untouched.`
    );
  }
  return { ok: true, phase, availableBytes: available, requiredBytes: required };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(ensureFreeSpace(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
