"use client";

// nexa overlay (net-new): Provider-Quota per-account model enumeration.
//
// WHY: the Codex quota card is built purely from chatgpt.com/backend-api/wham/usage
// (open-sse/services/codexUsageQuotas.ts), which reports only rate-limit WINDOWS —
// the shared "Session" (5h) + "Weekly" (7d) + code-review windows, plus Spark's OWN
// separate metered pool. Spark shows because it has a distinct pool; every other
// model (gpt-5.6-sol/terra/luna, 5.5, 5.4, …) draws from the single shared Session
// window and is therefore never enumerated as a row. The model catalog is not
// consulted for that page at all.
//
// This component is DISPLAY-ONLY and ADDITIVE: it lists every catalog model the
// account can serve (the same registry list /v1/models exposes for the provider,
// via the client-safe getModelsByProviderId), grouped by the quota window it draws
// from. It does NOT touch the quota rows, status computation, cutoff/enforcement, or
// routing — it renders below them.

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { getModelsByProviderId } from "@omniroute/open-sse/config/providerModels.ts";
import { translateUsageOrFallback } from "../i18nFallback";

type ModelChip = { id: string; name: string; gated: boolean };
type ModelGroup = { key: string; label: string; fallback: string; models: ModelChip[] };

/**
 * Codex slugs the ChatGPT/Codex OAuth backend currently rejects with
 * 400 "The '<model>' model is not supported when using Codex with a ChatGPT
 * account." on ChatGPT Pro accounts (entitlement-gated by OpenAI — verified live
 * 2026-07-18 against both Pro accounts). Still listed (owner wants every model
 * shown) but marked so operators know they are not presently routable here.
 */
function isEntitlementGatedCodexModel(id: string): boolean {
  if (/-pro$/i.test(id)) return true;
  return id === "gpt-5.1-codex-max" || id === "gpt-5.1-codex-mini" || id === "gpt-5.2-codex";
}

/** Which usage window a Codex catalog model draws from (drives grouping). */
function codexWindowKey(id: string): "spark" | "review" | "session" {
  if (/spark/i.test(id)) return "spark";
  if (id === "codex-auto-review") return "review";
  return "session";
}

interface Props {
  provider: string;
}

export default function QuotaModelList({ provider }: Props) {
  const t = useTranslations("usage");
  const tr = (key: string, fallback: string) => translateUsageOrFallback(t, key, fallback);

  const groups = useMemo<ModelGroup[] | null>(() => {
    // Scoped to Codex: the surface whose usage API is window-metered (not
    // per-model), so its card otherwise hides the lineup. Other providers already
    // enumerate per-model rows or use API-key catalogs.
    if (provider !== "codex") return null;
    const models = getModelsByProviderId(provider);
    if (!models.length) return null;

    const session: ModelChip[] = [];
    const spark: ModelChip[] = [];
    const review: ModelChip[] = [];
    for (const m of models) {
      const chip: ModelChip = {
        id: m.id,
        name: m.name || m.id,
        gated: isEntitlementGatedCodexModel(m.id),
      };
      const w = codexWindowKey(m.id);
      if (w === "spark") spark.push(chip);
      else if (w === "review") review.push(chip);
      else session.push(chip);
    }

    const out: ModelGroup[] = [];
    if (session.length)
      out.push({ key: "session", label: "quotaModelsSession", fallback: "Session", models: session });
    if (spark.length)
      out.push({ key: "spark", label: "quotaModelsSpark", fallback: "Spark pool", models: spark });
    if (review.length)
      out.push({ key: "review", label: "quotaModelsReview", fallback: "Code review", models: review });
    return out.length ? out : null;
  }, [provider]);

  if (!groups) return null;

  const total = groups.reduce((n, g) => n + g.models.length, 0);

  return (
    <div className="mt-1 border-t border-border/40 pt-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-text-muted">
        <span className="material-symbols-outlined text-[13px] leading-none">list_alt</span>
        <span>{tr("quotaModelsHeading", "Models on this account")}</span>
        <span className="opacity-70 tabular-nums">{total}</span>
      </div>
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <span className="text-[10px] font-medium text-text-muted">
            {tr(group.label, group.fallback)}
          </span>
          <div className="flex flex-wrap gap-1">
            {group.models.map((model) => (
              <span
                key={model.id}
                title={
                  model.gated
                    ? `${model.id} — ${tr(
                        "quotaModelGatedTooltip",
                        "not available on ChatGPT-account Codex (entitlement-gated)"
                      )}`
                    : model.id
                }
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                  model.gated
                    ? "border-border/60 text-text-muted opacity-60"
                    : "border-border text-text-main"
                }`}
              >
                {model.name}
                {model.gated && (
                  <span
                    className="material-symbols-outlined text-[11px] leading-none"
                    aria-hidden
                  >
                    lock
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
