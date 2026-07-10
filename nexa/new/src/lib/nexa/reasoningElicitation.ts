// nexa overlay — gateway-level VISIBLE-REASONING elicitation for Claude models.
//
// WHY: Claude Code OAuth (`cc/…`) HARD-REDACTS extended-thinking text — Anthropic
// streams a `thinking` content block that carries only a `signature_delta`
// (encrypted) plus an empty `thinking_delta`, so no reasoning text ever reaches
// the OpenAI-shape `reasoning_content` field. (Gemini / GPT-5.x expose their
// reasoning natively; only the Claude OAuth tier redacts.) No response-translator
// change can un-redact encrypted upstream thinking.
//
// FIX: when a caller OPTS IN via the `x-omniroute-reasoning-tag` header AND the
// model is a Claude model, ask the model to wrap its reasoning in
// <omni:reasoning>…</omni:reasoning>, then re-surface that span as native OpenAI
// `reasoning_content` deltas (stripping it from `content`). Any consumer then
// gets real, visible Claude reasoning through the standard field.
//
// SAFETY: strictly opt-in (header) AND Claude-only. Without the header — every
// existing coding-agent / default request — behaviour is byte-for-byte untouched.

export const REASONING_ELICIT_HEADER = "x-omniroute-reasoning-tag";
const OPEN = "<omni:reasoning>";
const CLOSE = "</omni:reasoning>";

const ELICIT_SYSTEM =
  "Structure EVERY response in two parts. FIRST write your full, genuine, " +
  "step-by-step reasoning wrapped EXACTLY in " +
  OPEN +
  " and " +
  CLOSE +
  " tags. THEN, after the closing tag, write ONLY your normal answer. The wrapped " +
  "reasoning is surfaced to the operator as a private thinking panel and is NOT " +
  "shown to the end user; the text after the closing tag is the user-facing answer. " +
  "Always include BOTH parts, in that order.";

export function reasoningElicitationRequested(request: Request): boolean {
  const v = request.headers.get(REASONING_ELICIT_HEADER);
  return v === "1" || v === "true" || v === "tag";
}

export function isClaudeModel(model: unknown): boolean {
  return typeof model === "string" && /claude/i.test(model);
}

/**
 * Prepend the reasoning-elicitation system directive. Applied to EVERY model
 * when the caller opts in — Claude's thinking is redacted, and some providers
 * (e.g. GPT-5.x/Codex) emit their native reasoning summary only intermittently;
 * the in-band tag is the one reliable, uniform source across the panel. The
 * header gate keeps this off every default (coding-agent) request.
 */
export function injectReasoningElicitation(_model: unknown, body: unknown): void {
  if (!body || typeof body !== "object") return;
  const b = body as { messages?: unknown };
  if (!Array.isArray(b.messages)) return;
  b.messages.unshift({ role: "system", content: ELICIT_SYSTEM });
}

// ── streaming tag splitter ────────────────────────────────────────────────
// Longest suffix of `buf` that is a proper prefix of `tag` (partial tag that
// may complete in the next chunk → hold it back rather than emit prematurely).
function holdbackLen(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (tag.startsWith(buf.slice(buf.length - k))) return k;
  }
  return 0;
}

type Seg = { kind: "content" | "reasoning"; text: string };

class TagSplitter {
  private mode: "content" | "reasoning" = "content";
  private buf = "";

  push(text: string): Seg[] {
    this.buf += text;
    const out: Seg[] = [];
    for (;;) {
      if (this.mode === "content") {
        const i = this.buf.indexOf(OPEN);
        if (i >= 0) {
          if (i > 0) out.push({ kind: "content", text: this.buf.slice(0, i) });
          this.buf = this.buf.slice(i + OPEN.length);
          this.mode = "reasoning";
          continue;
        }
        const hb = holdbackLen(this.buf, OPEN);
        const safe = this.buf.length - hb;
        if (safe > 0) {
          out.push({ kind: "content", text: this.buf.slice(0, safe) });
          this.buf = this.buf.slice(safe);
        }
        break;
      } else {
        const i = this.buf.indexOf(CLOSE);
        if (i >= 0) {
          if (i > 0) out.push({ kind: "reasoning", text: this.buf.slice(0, i) });
          this.buf = this.buf.slice(i + CLOSE.length);
          this.mode = "content";
          continue;
        }
        const hb = holdbackLen(this.buf, CLOSE);
        const safe = this.buf.length - hb;
        if (safe > 0) {
          out.push({ kind: "reasoning", text: this.buf.slice(0, safe) });
          this.buf = this.buf.slice(safe);
        }
        break;
      }
    }
    return out;
  }

  flush(): Seg[] {
    if (!this.buf) return [];
    const seg: Seg = { kind: this.mode, text: this.buf };
    this.buf = "";
    return [seg];
  }
}

function cloneChunk(base: Record<string, unknown>, delta: Record<string, unknown>) {
  const choices = Array.isArray(base.choices) ? base.choices : [{}];
  const first = { ...(choices[0] as Record<string, unknown>) };
  first.delta = delta;
  return { ...base, choices: [first, ...choices.slice(1)] };
}

/** Split one OpenAI chunk's `content` into content / reasoning_content sub-chunks. */
function rewriteChunk(json: Record<string, unknown>, splitter: TagSplitter): string[] {
  const choice = (Array.isArray(json.choices) ? json.choices[0] : null) as
    | Record<string, unknown>
    | null;
  const delta = (choice?.delta ?? null) as Record<string, unknown> | null;
  const content = delta?.content;
  if (typeof content !== "string" || content.length === 0) {
    // In elicit mode the <omni:reasoning> tag is the single reasoning source —
    // drop the provider's own (intermittent) reasoning_content so the panel's
    // thinking isn't duplicated. Preserve every other field (role, usage, …).
    if (delta && typeof delta.reasoning_content === "string") {
      const rest: Record<string, unknown> = { ...delta };
      delete rest.reasoning_content;
      if (Object.keys(rest).length === 0) return [];
      return ["data: " + JSON.stringify(cloneChunk(json, rest))];
    }
    return ["data: " + JSON.stringify(json)];
  }
  const segs = splitter.push(content);
  const otherDelta: Record<string, unknown> = { ...delta };
  delete otherDelta.content;
  if (segs.length === 0) {
    // Whole content held back (mid-tag) — emit only the non-content delta fields
    // (e.g. role) if any; otherwise emit nothing this chunk.
    if (Object.keys(otherDelta).length === 0) return [];
    return ["data: " + JSON.stringify(cloneChunk(json, otherDelta))];
  }
  const lines: string[] = [];
  segs.forEach((s, idx) => {
    const field = s.kind === "reasoning" ? "reasoning_content" : "content";
    const d: Record<string, unknown> = idx === 0 ? { ...otherDelta } : {};
    d[field] = s.text;
    lines.push("data: " + JSON.stringify(cloneChunk(json, d)));
  });
  return lines;
}

/** Wrap an OpenAI SSE body, moving <omni:reasoning> spans to reasoning_content. */
export function wrapReasoningSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const splitter = new TagSplitter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuf = "";

  const emitFlush = (controller: TransformStreamDefaultController) => {
    for (const s of splitter.flush()) {
      const field = s.kind === "reasoning" ? "reasoning_content" : "content";
      const chunk = {
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { [field]: s.text } }],
      };
      controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
    }
  };

  const handleLine = (line: string, controller: TransformStreamDefaultController) => {
    if (!line.startsWith("data:")) {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    const payload = (line.startsWith("data: ") ? line.slice(6) : line.slice(5)).trim();
    if (payload === "[DONE]") {
      emitFlush(controller);
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    if (!payload.startsWith("{")) {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload);
    } catch {
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }
    for (const out of rewriteChunk(json, splitter)) {
      controller.enqueue(encoder.encode(out + "\n"));
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      lineBuf += decoder.decode(chunk, { stream: true });
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() || "";
      for (const line of lines) handleLine(line, controller);
    },
    flush(controller) {
      const rest = decoder.decode() + lineBuf;
      if (rest) handleLine(rest, controller);
      emitFlush(controller);
    },
  });
  return body.pipeThrough(transform);
}

function tagSplit(content: string): { content: string; reasoning: string } {
  const splitter = new TagSplitter();
  const segs = [...splitter.push(content), ...splitter.flush()];
  let reasoning = "";
  let body = "";
  for (const s of segs) (s.kind === "reasoning" ? (reasoning += s.text) : (body += s.text));
  return { content: body, reasoning };
}

/** Non-streaming JSON: split message.content into content + reasoning_content. */
export function splitJsonReasoning(json: unknown): unknown {
  if (!json || typeof json !== "object") return json;
  const j = json as Record<string, unknown>;
  const choices = Array.isArray(j.choices) ? j.choices : null;
  if (!choices) return json;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== "string" || !content.includes(OPEN)) return json;
  const { content: body, reasoning } = tagSplit(content);
  const newMessage = { ...message, content: body.trim() } as Record<string, unknown>;
  if (reasoning.trim()) newMessage.reasoning_content = reasoning.trim();
  return { ...j, choices: [{ ...first, message: newMessage }, ...choices.slice(1)] };
}

/**
 * Non-streaming: reassemble the body (a single JSON completion OR a streamed-200
 * SSE body — OmniRoute may return either even for stream:false) into ONE clean
 * OpenAI JSON completion with the <omni:reasoning> span moved to
 * reasoning_content. Deterministic — the caller (gateway) always gets JSON.
 */
export function reassembleAndSplit(text: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      return splitJsonReasoning(JSON.parse(trimmed));
    } catch {
      /* fall through to SSE reassembly */
    }
  }
  let content = "";
  let reasoning = "";
  let id = "";
  let model = "";
  let finish: unknown = null;
  let usage: unknown;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const p = (s.startsWith("data: ") ? s.slice(6) : s.slice(5)).trim();
    if (!p || p === "[DONE]") continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(p);
    } catch {
      continue;
    }
    if (typeof j.id === "string") id = j.id;
    if (typeof j.model === "string") model = j.model;
    const ch = (Array.isArray(j.choices) ? j.choices[0] : null) as
      | Record<string, unknown>
      | null;
    const d = (ch?.delta ?? null) as Record<string, unknown> | null;
    const m = (ch?.message ?? null) as Record<string, unknown> | null;
    if (typeof d?.content === "string") content += d.content;
    if (typeof d?.reasoning_content === "string") reasoning += d.reasoning_content;
    if (typeof m?.content === "string") content += m.content;
    if (typeof m?.reasoning_content === "string") reasoning += m.reasoning_content;
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (j.usage) usage = j.usage;
  }
  const split = tagSplit(content);
  // Prefer the elicited <omni:reasoning> tag; fall back to the provider's own
  // reasoning_content only when the model emitted no tag (avoids duplication).
  const finalReasoning = split.reasoning.trim() || reasoning.trim();
  return {
    id: id || "chatcmpl-nexa",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: split.content.trim(),
          ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
        },
        finish_reason: finish || "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/**
 * Wrap a handleChat Response, applying the split when the caller opted in.
 * `streaming` = the request asked for live SSE (stream:true) → transform the
 * stream in place. Otherwise buffer + reassemble to a single clean JSON body
 * (robust to OmniRoute answering a stream:false request with an SSE body).
 */
export async function wrapReasoningResponse(
  request: Request,
  response: Response,
  streaming: boolean
): Promise<Response> {
  if (!reasoningElicitationRequested(request) || !response.body) return response;
  const ct = response.headers.get("content-type") ?? "";
  if (streaming && ct.includes("text/event-stream")) {
    return new Response(wrapReasoningSse(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const text = await response.text();
  const json = reassembleAndSplit(text);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(json), { status: response.status, headers });
}
