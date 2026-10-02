import test from "node:test";
import assert from "node:assert/strict";
import { createTrafficEventStream } from "../../src/mitm/inspector/eventStream.ts";
import type { WsEvent } from "../../src/mitm/inspector/types.ts";

test("event stream sends snapshot and updates, releasing subscription on abort", async () => {
  const abort = new AbortController();
  let subscriber: ((event: WsEvent) => void) | undefined;
  let released = 0;
  const stream = createTrafficEventStream(
    {
      list: () => [],
      subscribe: (fn) => {
        subscriber = fn;
        return () => {
          released++;
        };
      },
    },
    abort.signal
  );
  const reader = stream.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"snapshot"/);
  subscriber!({ type: "clear" });
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"clear"/);
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(released, 1);
});

test("event stream cancel and already-aborted clients do not leak subscribers", async () => {
  const abort = new AbortController();
  abort.abort();
  let subscribers = 0;
  const buffer = {
    list: () => [],
    subscribe: () => {
      subscribers++;
      return () => {
        subscribers--;
      };
    },
  };
  assert.equal(
    (await createTrafficEventStream(buffer, abort.signal).getReader().read()).done,
    true
  );
  assert.equal(subscribers, 0);
  const stream = createTrafficEventStream(buffer, new AbortController().signal);
  assert.equal(subscribers, 1);
  await stream.cancel();
  assert.equal(subscribers, 0);
});
