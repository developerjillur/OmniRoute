#!/usr/bin/env node
// nexa/gen-manifest.mjs — regenerate nexa/manifest.json from the live overlay contents.
// The manifest is the registry: every customization, which ladder-layer it occupies, its
// class (nexa-specific vs upstream-candidate), and its upstream target. Seeds class from the
// recovered legacy map when present; defaults new items to needs-review.
import fs from "node:fs";
import path from "node:path";
import { NEXA, listPatches, listNewFiles, patchTarget, baseVersion, git } from "./lib/overlay.mjs";

const legacyPath = path.join(NEXA, ".work", "old-classes.json");
const legacy = fs.existsSync(legacyPath) ? JSON.parse(fs.readFileSync(legacyPath, "utf8")) : {};
const classify = (file) => legacy[file]?.class || "needs-review";

const patches = listPatches().map((p) => {
  const target = patchTarget(p);
  return {
    file: path.relative(NEXA, p),
    layer: "patch",
    class: classify(target),
    target,
    conflictRisk: "on-overlap",
    upstreamPR: null,
  };
});
const news = listNewFiles().map((n) => ({
  file: `new/${n.dest}`,
  layer: "new",
  class: classify(n.dest),
  target: n.dest,
  conflictRisk: "none",
  upstreamPR: null,
}));
const tooling = [];
const push = (rel, cls) => {
  if (fs.existsSync(path.join(NEXA, rel)))
    tooling.push({ file: rel, layer: "tooling", class: cls, conflictRisk: "none" });
};
["skill/nexa-overlay", "agent/nexa-overlay-maintainer.md"].forEach((f) => push(f, "nexa-specific"));

const { sha, version } = baseVersion();
const items = [...patches, ...news, ...tooling];
const count = (pred) => items.filter(pred).length;

const manifest = {
  _comment:
    "NexaLance OmniRoute child-theme overlay registry. layer: patch=surgical diff onto pristine upstream; " +
    "new=net-new file copied in at build; tooling=overlay machinery. class: upstream-candidate=generic fix worth " +
    "PRing to diegosouzapw/OmniRoute (Phase-2 shrinker); nexa-specific=stays in the overlay; needs-review=triage. " +
    "Base stays byte-for-byte pristine; regenerate with `node nexa/gen-manifest.mjs`.",
  upstreamBase: { sha, version },
  productionBranch: "nexalance",
  generatedFrom: "live nexa/ contents",
  counts: {
    total: items.length,
    patches: patches.length,
    new: news.length,
    tooling: tooling.length,
    upstreamCandidates: count((i) => i.class === "upstream-candidate"),
    nexaSpecific: count((i) => i.class === "nexa-specific"),
    needsReview: count((i) => i.class === "needs-review"),
  },
  items,
};

fs.writeFileSync(path.join(NEXA, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `  ✓ wrote nexa/manifest.json — ${manifest.counts.total} items (${patches.length} patch, ${news.length} new, ${tooling.length} tooling)`
);
console.log(
  `    class: ${manifest.counts.upstreamCandidates} upstream-candidate · ${manifest.counts.nexaSpecific} nexa-specific · ${manifest.counts.needsReview} needs-review`
);
