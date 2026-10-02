import { globalTrafficBuffer } from "@/mitm/inspector/buffer";
import { createTrafficEventStream } from "@/mitm/inspector/eventStream";

export const dynamic = "force-dynamic";

/** The existing traffic-inspector prefix enforces local access and dashboard authentication. */
export async function GET(request: Request): Promise<Response> {
  return new Response(createTrafficEventStream(globalTrafficBuffer, request.signal), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
