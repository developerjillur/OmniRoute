import type { WsEvent } from "./types.ts";

interface EventBuffer {
  list(): unknown[];
  subscribe(callback: (event: WsEvent) => void): () => void;
}

/** HTTP event stream for runtimes that do not expose a WebSocket upgrade socket. */
export function createTrafficEventStream(
  buffer: EventBuffer,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let close = () => {};
  return new ReadableStream({
    start(controller) {
      let ended = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      close = () => {
        if (ended) return;
        ended = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          /* Consumer already canceled. */
        }
      };
      const send = (event: unknown) => {
        if (ended) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          close();
        }
      };
      if (signal.aborted) {
        close();
        return;
      }
      signal.addEventListener("abort", close, { once: true });
      send({ type: "snapshot", data: buffer.list() });
      unsubscribe = buffer.subscribe(send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          close();
        }
      }, 15_000);
      heartbeat.unref();
    },
    cancel() {
      close();
    },
  });
}
