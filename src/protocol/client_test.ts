/**
 * End-to-end client ↔ daemon test (contract C5) over an in-memory stream pair.
 *
 * Wires ProtocolClient to createDaemon(memoryBackend) through two TransformStreams — the same shape
 * as a Unix socket — and exercises every typed call plus concurrent id correlation. This closes the
 * loop: the shell's client, the daemon's dispatch, and the wire codec all working together.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { ProtocolClient } from "./client.ts";
import { createDaemon } from "./server.ts";
import { serveConn } from "./server.ts";
import { memoryBackend, type MemorySeed } from "./memory_backend.ts";

const seed: MemorySeed = {
  version: "1.0.0",
  engine: "memory",
  uptimeMs: 7,
  namespaces: [
    {
      name: "research",
      objects: [
        {
          id: "obj-1",
          name: "ResearchAgent",
          alarm: 4102444800000,
          storage: { "k:1": 1, "k:2": 2, other: 9 },
        },
      ],
    },
  ],
  logs: [{
    at: 1,
    level: "info",
    namespace: "research",
    objectId: "obj-1",
    message: "hi",
  }],
};

function connectedClient(): { client: ProtocolClient; serverDone: Promise<void> } {
  const c2s = new TransformStream<Uint8Array, Uint8Array>();
  const s2c = new TransformStream<Uint8Array, Uint8Array>();
  const daemon = createDaemon(memoryBackend(seed));
  const serverDone = serveConn(
    { readable: c2s.readable, writable: s2c.writable },
    daemon,
  );
  const client = new ProtocolClient({ readable: s2c.readable, writable: c2s.writable });
  return { client, serverDone };
}

Deno.test("client round-trips every method against the daemon", async () => {
  const { client, serverDone } = connectedClient();

  assertEquals(await client.status(), {
    version: "1.0.0",
    engine: "memory",
    uptimeMs: 7,
  });
  assertEquals(await client.namespaces(), [{ name: "research", objectCount: 1 }]);
  assertEquals(await client.objects("research"), [
    { id: "obj-1", name: "ResearchAgent", namespace: "research", hasAlarm: true },
  ]);
  assertEquals(await client.storageList("research", "obj-1", { prefix: "k:" }), [[
    "k:1",
    1,
  ], ["k:2", 2]]);
  assertEquals(await client.storageGet("research", "obj-1", "missing"), null);
  assertEquals(await client.alarmGet("research", "obj-1"), 4102444800000);
  assertEquals((await client.logsTail({ limit: 1 }))[0].message, "hi");

  await client.close();
  await serverDone;
});

Deno.test("concurrent calls correlate to the right responses by id", async () => {
  const { client, serverDone } = connectedClient();

  const [status, namespaces, objects] = await Promise.all([
    client.status(),
    client.namespaces(),
    client.objects("research"),
  ]);
  assertEquals(status.version, "1.0.0");
  assertEquals(namespaces[0].name, "research");
  assertEquals(objects[0].id, "obj-1");

  await client.close();
  await serverDone;
});

Deno.test("pending calls reject when the connection closes", async () => {
  const { client, serverDone } = connectedClient();
  await client.close();
  await serverDone;
  // A call after close is rejected rather than hanging forever.
  let threw = false;
  try {
    await client.status();
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("calls reject after the peer closes its response stream", async () => {
  const responses = new TransformStream<Uint8Array, Uint8Array>();
  const client = new ProtocolClient({
    readable: responses.readable,
    writable: new WritableStream<Uint8Array>(),
  });
  const pending = assertRejects(() => client.status(), Error, "connection closed");
  await responses.writable.close();
  await pending;

  await assertRejects(() => client.status(), Error, "closed");
  await client.close();
});
