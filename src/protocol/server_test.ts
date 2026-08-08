/**
 * Tests for the daemon server dispatch and NDJSON transport (contract C5).
 *
 * Exercises createDaemon over the in-memory backend end-to-end, confirms decode/dispatch errors
 * become well-formed error frames, and runs serveConn over an in-memory stream pair.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { createDaemon, type DaemonBackend, handleLine, serveConn } from "./server.ts";
import { memoryBackend, type MemorySeed } from "./memory_backend.ts";
import { decode, encode } from "./codec.ts";
import type { Ok, Request, Response } from "./messages.ts";

const seed: MemorySeed = {
  version: "1.2.3",
  engine: "memory",
  uptimeMs: 42,
  namespaces: [
    {
      name: "research",
      objects: [
        {
          id: "obj-1",
          name: "ResearchAgent",
          alarm: 4102444800000,
          storage: { "user:1": "a", "user:2": "b", "post:1": "p" },
        },
      ],
    },
  ],
  logs: [
    { at: 1, level: "info", namespace: "research", objectId: "obj-1", message: "woke" },
    { at: 2, level: "error", namespace: "research", objectId: "obj-1", message: "boom" },
  ],
};

const daemon = createDaemon(memoryBackend(seed));
const call = async <T>(req: Request): Promise<T> => {
  const res = await daemon(req);
  assert(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  return (res as Ok<T>).result;
};

Deno.test("status returns daemon info", async () => {
  assertEquals(await call({ id: 1, method: "status", params: {} }), {
    version: "1.2.3",
    engine: "memory",
    uptimeMs: 42,
  });
});

Deno.test("namespaces and objects list", async () => {
  assertEquals(await call({ id: 2, method: "namespaces.list", params: {} }), [
    { name: "research", objectCount: 1 },
  ]);
  assertEquals(
    await call({ id: 3, method: "objects.list", params: { namespace: "research" } }),
    [
      { id: "obj-1", name: "ResearchAgent", namespace: "research", hasAlarm: true },
    ],
  );
});

Deno.test("storage list is sorted and prefix-filtered; get returns null for misses", async () => {
  const entries = await call({
    id: 4,
    method: "storage.list",
    params: { namespace: "research", objectId: "obj-1", prefix: "user:" },
  });
  assertEquals(entries, [["user:1", "a"], ["user:2", "b"]]);

  assertEquals(
    await call({
      id: 5,
      method: "storage.get",
      params: { namespace: "research", objectId: "obj-1", key: "nope" },
    }),
    null,
  );
});

Deno.test("alarms.get and logs.tail", async () => {
  assertEquals(
    await call({
      id: 6,
      method: "alarms.get",
      params: { namespace: "research", objectId: "obj-1" },
    }),
    4102444800000,
  );
  const logs = await call<{ message: string }[]>({
    id: 7,
    method: "logs.tail",
    params: { limit: 1 },
  });
  assertEquals(logs.length, 1);
  assertEquals(logs[0].message, "boom"); // last one
});

Deno.test("a throwing backend yields an internal error frame", async () => {
  const broken: DaemonBackend = {
    ...memoryBackend(seed),
    objects() {
      throw new Error("kaboom");
    },
  };
  const res = await createDaemon(broken)({
    id: 8,
    method: "objects.list",
    params: { namespace: "x" },
  });
  assert(!res.ok);
  assertEquals(res.error.code, "internal");
  assert(res.error.message.includes("kaboom"));
});

Deno.test("handleLine turns bad frames and non-requests into error frames", async () => {
  const bad = decode(await handleLine("not json", daemon)) as Response;
  assert(!bad.ok && bad.error.code === "bad_request");

  // A response frame sent to the server is not a request.
  const notReq = decode(
    await handleLine(encode({ id: 9, ok: true, result: 1 }), daemon),
  ) as Response;
  assert(!notReq.ok && notReq.error.code === "bad_request");
});

Deno.test("serveConn answers framed requests over a stream", async () => {
  const input = [
    encode({ id: 1, method: "status", params: {} }) + "\n",
    encode({ id: 2, method: "namespaces.list", params: {} }) + "\n",
  ].map((s) => new TextEncoder().encode(s));

  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });

  await serveConn({ readable: ReadableStream.from(input), writable }, daemon);

  const text = written.map((c) => new TextDecoder().decode(c)).join("");
  const lines = text.split("\n").filter((l) => l.length > 0);
  assertEquals(lines.length, 2);
  const first = decode(lines[0]) as Ok<unknown>;
  assertEquals(first.id, 1);
  assert(first.ok);
});
