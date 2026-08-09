/**
 * Daemon integration test (contract C5): a real client over a real Unix socket.
 *
 * Unlike client_test.ts (in-memory streams), this binds an actual `Deno.listen`/`Deno.connect` unix
 * socket, proving the transport end to end — and that the daemon serves multiple connections.
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { serveUnix } from "./main.ts";
import { memoryBackend, type MemorySeed } from "../protocol/memory_backend.ts";
import { ProtocolClient } from "../protocol/client.ts";

const seed: MemorySeed = {
  version: "9.9.9",
  engine: "memory",
  uptimeMs: 5,
  namespaces: [
    {
      name: "research",
      objects: [
        {
          id: "o1",
          name: "ResearchAgent",
          alarm: 4102444800000,
          storage: { a: 1, b: 2 },
        },
      ],
    },
  ],
};

async function withDaemon(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "resagent-sock-" });
  const path = `${dir}/d.sock`;
  const daemon = serveUnix(path, memoryBackend(seed));
  try {
    await fn(path);
  } finally {
    await daemon.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("a client talks to the daemon over a real unix socket", async () => {
  await withDaemon(async (path) => {
    const client = new ProtocolClient(await Deno.connect({ path, transport: "unix" }));
    assertEquals((await client.status()).engine, "memory");
    assertEquals(await client.namespaces(), [{ name: "research", objectCount: 1 }]);
    assertEquals(await client.storageList("research", "o1", {}), [["a", 1], ["b", 2]]);
    assertEquals(await client.alarmGet("research", "o1"), 4102444800000);
    await client.close();
  });
});

Deno.test("the daemon serves multiple concurrent connections", async () => {
  await withDaemon(async (path) => {
    const c1 = new ProtocolClient(await Deno.connect({ path, transport: "unix" }));
    const c2 = new ProtocolClient(await Deno.connect({ path, transport: "unix" }));
    const [status, namespaces] = await Promise.all([c1.status(), c2.namespaces()]);
    assertEquals(status.version, "9.9.9");
    assertEquals(namespaces[0].name, "research");
    await Promise.all([c1.close(), c2.close()]);
  });
});

Deno.test("close() removes the socket file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "resagent-sock-" });
  const path = `${dir}/d.sock`;
  const daemon = serveUnix(path, memoryBackend(seed));
  await (await Deno.connect({ path, transport: "unix" })).close?.();
  await daemon.close();
  let exists = true;
  try {
    await Deno.stat(path);
  } catch {
    exists = false;
  }
  assertEquals(exists, false);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});
