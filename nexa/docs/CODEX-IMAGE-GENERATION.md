# Codex image generation on OmniRoute — the durable reference

> **TL;DR** — To generate an image through OmniRoute on the ChatGPT/Codex **subscription**
> (no API key, **$0 per image**), call the OpenAI-compatible images endpoint with model
> **`codex/gpt-5.5`**:
>
> ```
> POST https://omni.nexaconnect.cloud/v1/images/generations
> Authorization: Bearer $OMNIROUTE_API_KEY
> { "model": "codex/gpt-5.5", "prompt": "...", "n": 1, "size": "1024x1024", "response_format": "b64_json" }
> ```
>
> The **only** subscription-based image model id that works today is **`codex/gpt-5.5`**
> (alias `cx/gpt-5.5`). `gpt-image-2` and `gpt-5.6` are **rejected** by the ChatGPT backend
> — see the model matrix below. This lives in **upstream** OmniRoute, so verify it still
> works after every `node nexa/update.mjs` (one curl, below).

_Last verified live: 2026-07-21 against `omniroute-prod` — HTTP 200, ~25–30 s, ~1.8–2.2 MB
photorealistic PNGs with C2PA provenance metadata. Also verified end-to-end through
NexaConnect `/chat` `/image` on beta + prod._

---

## 1. Why this doc exists

This is the knowledge that was expensive to discover and must NOT be lost on the next
OmniRoute upstream update. It captures: the working endpoint, the exact model id, what
does **not** work and **why**, how it is wired inside OmniRoute, how NexaConnect consumes
it, and the recovery recipe if a future upstream change moves it.

It lives in `nexa/` (the child-theme overlay), which upstream never touches — so
`git merge upstream/main` / `node nexa/update.mjs` leave it intact.

## 2. The endpoint

OmniRoute exposes an OpenAI-compatible images surface:

```
POST /v1/images/generations
```

Request body (OpenAI `images.generate` shape): `{ model, prompt, n, size, response_format }`.
Response: `{ "created": <ts>, "data": [ { "b64_json": "<base64 PNG>" } ] }`
(or `{ "url": ... }` when `response_format` is omitted).

**Copy-paste verify (run on the VPS so `$OMNIROUTE_API_KEY` is sourced from the env; never
print the key):**

```bash
set -a; . /opt/omniroute/.env; set +a
curl -sS -m 300 https://omni.nexaconnect.cloud/v1/images/generations \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"codex/gpt-5.5","prompt":"a red ceramic coffee mug on a wooden table, warm light","n":1,"size":"1024x1024","response_format":"b64_json"}' \
  | python3 -c "import json,sys,base64,os;d=json.load(sys.stdin);b=(d.get('data') or [{}])[0].get('b64_json');open('/tmp/verify.png','wb').write(base64.b64decode(b)) if b else print('FAIL',d);print('OK',os.path.getsize('/tmp/verify.png'),'bytes') if b else None"
```

HTTP 200 + a multi-hundred-KB PNG = healthy.

## 3. Model matrix — what works and what does NOT (and why)

| Model id | Works? | Auth | Notes |
| --- | --- | --- | --- |
| **`codex/gpt-5.5`** (alias `cx/gpt-5.5`) | ✅ **YES** | OmniRoute Codex **OAuth** (subscription) | The one subscription image model. `$0` per image. **Use this.** |
| `antigravity/gemini-3.1-flash-image` | ✅ yes | Antigravity OAuth (subscription) | Fallback. Quality lower; hits `429 RESOURCE_EXHAUSTED` when quota drained. |
| `openai/gpt-image-2` | ❌ no | — | `"No credentials for image provider: openai"` — the OpenAI provider was removed from OmniRoute for embeddings-isolation. |
| `cx/gpt-image-2` | ❌ no | — | `"gpt-image-2 is not supported when using Codex with a ChatGPT account."` |
| `codex/gpt-5.6`, `cx/gpt-5.6` | ❌ no | — | `"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."` gpt-5.6 works for **coding/chat** via the Codex CLI, but the ChatGPT-account codex **image** endpoint only allows an upstream allowlist (today: `gpt-5.5`). Re-test when OpenAI widens it. |

**Key lesson:** the codex **image** model is **`gpt-5.5`**, NOT `gpt-image-2`. An earlier
belief that "OmniRoute can't do gpt-image-2 server-side" was true only for that *wrong model
id* — `codex/gpt-5.5` works and always did.

## 4. How it works under the hood (OmniRoute internals)

- **Provider registry:** `open-sse/config/imageRegistry.ts` → `IMAGE_PROVIDERS.codex`:
  ```ts
  codex: {
    id: "codex", alias: "cx",
    baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    authType: "oauth", authHeader: "bearer",
    format: "codex-responses",
    models: [{ id: "gpt-5.5", name: "GPT 5.5 (Codex Image)" }],
    supportedSizes: ["1024x1024", "1024x1536", "1536x1024"],
  }
  ```
- **Handler:** `open-sse/handlers/imageGeneration.ts` → `handleImageGeneration()` dispatches
  the `codex-responses` format to `handleCodexImageGeneration`, which **translates** the
  incoming `/v1/images/generations` request into a Codex **Responses-API** call with
  `tools: [{ type: "image_generation" }]` against `wss://chatgpt.com/backend-api/codex/responses`
  (see `open-sse/executors/codex.ts` `CODEX_RESPONSES_WS_URL`). The image comes back as a
  hosted-tool result; OmniRoute returns it as `{data:[{b64_json}]}`.
- **This is the same `image_generation` tool the Codex CLI uses on a Mac** — same underlying
  gpt-image model, same quality — but reached over HTTP with OmniRoute's stored OAuth token
  instead of a local `codex exec` subprocess. **No codex binary, git, or auth.json is needed
  on any server.**

## 5. Prerequisites (managed entirely from the OmniRoute dashboard)

1. **At least one OpenAI Codex account connected** via OAuth: dashboard → **Providers →
   OpenAI Codex** (shows "N Connected"). That connection is what authorizes image gen.
   Add a second Codex account there to split the load.
2. **Quota = the ChatGPT subscription weekly limit**, and it is **shared with any Codex
   coding usage** on the same account. Heavy image days compete with coding; add another
   Codex account in the dashboard to isolate.

## 6. How NexaConnect consumes it

NexaConnect's backend (`nexaConnectFreshBackend`) renders `/chat` `/image` + `/logo` and the
autonomous brain's images through **this** endpoint:

- File: `src/modules/attachments/attachment-forge.service.ts` → `generateImageBytes()`.
- **PRIMARY:** `generateViaOmniRoute(prompt, size, 'codex/gpt-5.5')`.
- **FALLBACK:** `antigravity/gemini-3.1-flash-image` (only if codex errors).
- **The paid OpenAI images API path was deleted entirely** (owner rule: subscription-only,
  no separate image bill). No `NEXA_IMAGE_OPENAI_*` code or env remains.
- **Env knobs** (backend `.env`, no code change to switch): `NEXA_IMAGE_CODEX_MODEL`
  (default `codex/gpt-5.5`), `NEXA_IMAGE_MODEL` (fallback, default the antigravity id),
  `NEXA_IMAGE_TIMEOUT_MS` (default 180000).
- Pipeline in chat: **Opus 4.8 art-director** (`plan_image`, max effort → detailed spec) →
  **`codex/gpt-5.5` render** (`generate_image`). BE images: staging `codeximg-f083319`,
  prod `prod-codeximg-f083319` (commit `f083319`).

## 7. Surviving OmniRoute updates — the checklist

The codex image provider is **upstream's** code, so a future upstream change *could* move or
rename it. After **every** `node nexa/update.mjs`:

1. **Run the verify curl** in §2. HTTP 200 + a PNG → nothing to do.
2. **If it now 400s / the model id changed**, find the new one:
   ```bash
   grep -n "codex-responses\|codex/backend-api/codex/responses\|GPT.*Codex Image" \
     open-sse/config/imageRegistry.ts
   ```
   Read the `codex` provider's `models[].id`, then set NexaConnect's env
   `NEXA_IMAGE_CODEX_MODEL=codex/<new-id>` on `/opt/backend{,-staging}/.env` and restart —
   **no code redeploy**.
3. **If upstream removed the codex image provider entirely** (unlikely), re-add it the
   overlay way: create `nexa/patches/open-sse__config__imageRegistry.ts.patch` re-inserting
   the `codex:` block from §4, register it in `nexa/manifest.json`, `node nexa/build.mjs`.

**When a newer model opens up** (e.g. gpt-5.6 for images someday): re-run the verify curl
with the new id; if it returns 200, just set `NEXA_IMAGE_CODEX_MODEL=codex/<new-id>` — one
env line, no redeploy.

## 8. Optional: the full-agentic `codex exec` path (tested, NOT deployed)

For completeness — the Codex **CLI** (`codex exec` → built-in `image_gen`) also renders
images headless on Linux using a copied `~/.codex/auth.json` (proven 2026-07-21 on the VPS).
It is the *full agentic loop* (can iterate/use skills) but costs ~18–20 K tokens/image and
needs the binary + credential on the box. The Responses-API path above was chosen instead
(faster, no subprocess, OmniRoute-managed OAuth). If a complex multi-image/iterative agentic
workflow is ever needed, that path can be added as a separate provider — but it is **not**
what powers NexaConnect today.
