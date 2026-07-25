#!/usr/bin/env node
// nexa/check/combo-models.mjs — the LIVE-ROSTER guard.
//
// Why this exists (2026-07-25): `nexa/hermes-brain` shipped with the tier
// `cx/gpt-5.6-sol-high` — a model id that does not exist on the gateway. A 5.5→5.6
// bump was applied without checking the roster. The combo kept "working", so nothing
// looked broken; the Codex tier just failed instantly on every call and was skipped.
// The owner's Claude → Codex → GLM cascade silently ran as Claude → GLM for days.
//
// That is the dangerous shape of this bug class: a dead tier is INVISIBLE. The only
// symptom is redundancy you think you have and don't. This script makes it loud.
//
// Usage (needs a live gateway):
//   set -a; source ~/.nexalance/omniroute-cloud.env; set +a
//   node nexa/check/combo-models.mjs
//
// Exit 0 = every combo tier resolves to a real model. Exit 1 = at least one dead tier.

const BASE = (process.env.OMNIROUTE_URL || "https://omni.nexaconnect.cloud").replace(/\/+$/, "");
const KEY = process.env.OMNIROUTE_API_KEY;

// Models we are waiting on upstream. Not failures — reported so we notice the DAY
// they land instead of rediscovering it months later. Owner asked for these
// explicitly (2026-07-21): Claude 5 family, all GPT-5.6 variants, Gemini 3.6 Flash.
const WATCHLIST = [
  { label: "Gemini 3.6 Flash", match: /gemini-3\.6/i },
  { label: "Claude Opus 5", match: /claude-opus-5/i },
];

if (!KEY) {
  console.error("  ✗ OMNIROUTE_API_KEY not set — source ~/.nexalance/omniroute-cloud.env first.");
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

let roster, combosRaw;
try {
  [roster, combosRaw] = await Promise.all([get("/v1/models"), get("/api/combos")]);
} catch (err) {
  console.error(`  ✗ cannot reach the gateway at ${BASE}: ${err.message}`);
  process.exit(1);
}

const ids = new Set((roster.data || []).map((m) => m.id));
const combos = Array.isArray(combosRaw) ? combosRaw : combosRaw.combos || [];

console.log(`  gateway ${BASE} — ${ids.size} models, ${combos.length} combos\n`);

const dead = [];
for (const combo of combos) {
  const tiers = combo.models || [];
  const bad = tiers.filter((t) => t.model && !ids.has(t.model));
  const mark = bad.length ? "✗" : "✓";
  console.log(`  ${mark} ${combo.name} — ${tiers.length} tiers`);
  for (const t of bad) {
    console.log(`      DEAD TIER: ${t.model}`);
    // Suggest the closest real ids so the fix is obvious, not a scavenger hunt.
    const stem = t.model
      .split("/")
      .pop()
      .replace(/-(high|low|max|pro|xhigh)$/, "");
    const near = [...ids].filter((i) => i.includes(stem)).slice(0, 5);
    if (near.length) console.log(`        did you mean: ${near.join(", ")}`);
    dead.push({ combo: combo.name, model: t.model });
  }
}

console.log("\n  --- watchlist (upstream availability) ---");
for (const w of WATCHLIST) {
  const hits = [...ids].filter((i) => w.match.test(i));
  console.log(
    hits.length
      ? `  ✓ ${w.label} HAS LANDED: ${hits.join(", ")}`
      : `  · ${w.label} — not yet upstream`
  );
}

if (!dead.length) {
  console.log("\n  ✓ every combo tier resolves to a real model.");
  process.exit(0);
}
console.error(`\n  ✗ ${dead.length} dead tier(s) — these fail instantly and are silently skipped:`);
for (const d of dead) console.error(`    • ${d.combo} → ${d.model}`);
console.error("\n  Fix via PUT /api/combos/<id> using an id that appears in GET /v1/models.");
process.exit(1);
