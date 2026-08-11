/**
 * The scoped filesystem broker (M10): a granted read/write works, an UNGRANTED SIBLING is refused
 * (the M10 exit criterion as a unit test), and the scoped write is proven over the C5 protocol. Uses
 * Deno.makeTempDir; CI-safe.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { GrantError, grantsService, scopedFs } from "./binding.ts";
import { memoryGrantStore } from "./grants.ts";
import { createDaemon, type DaemonBackend, handleLine } from "../protocol/server.ts";
import { memoryBackend } from "../protocol/memory_backend.ts";
import { encode } from "../protocol/codec.ts";

async function withGrantedDir(
  fn: (dirs: { granted: string; sibling: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "resagent-fs-" });
  try {
    const granted = `${root}/granted`;
    const sibling = `${root}/sibling`;
    await Deno.mkdir(granted);
    await Deno.mkdir(sibling);
    await fn({ granted, sibling });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("scopedFs: a granted write then read round-trips", async () => {
  await withGrantedDir(async ({ granted }) => {
    const store = memoryGrantStore();
    store.grant(granted, "read-write", 0);
    const fs = scopedFs(store);

    await fs.write(`${granted}/out.md`, "findings");
    assertEquals(await fs.read(`${granted}/out.md`), "findings");
    assert((await fs.list(granted)).includes("out.md"));
  });
});

Deno.test("scopedFs: an ungranted sibling is refused (M10 exit criterion)", async () => {
  await withGrantedDir(async ({ granted, sibling }) => {
    const store = memoryGrantStore();
    store.grant(granted, "read-write", 0);
    const fs = scopedFs(store);

    await assertRejects(
      () => fs.write(`${sibling}/leak.md`, "x"),
      GrantError,
      "no grant",
    );
    await assertRejects(() => fs.read(`${sibling}/anything`), GrantError, "no grant");
  });
});

Deno.test("scopedFs: a read-only grant refuses a write", async () => {
  await withGrantedDir(async ({ granted }) => {
    const store = memoryGrantStore();
    store.grant(granted, "read-only", 0);
    const fs = scopedFs(store);
    await assertRejects(
      () => fs.write(`${granted}/out.md`, "x"),
      GrantError,
      "read-only",
    );
  });
});

Deno.test("the scoped write is proven over the C5 protocol", async () => {
  await withGrantedDir(async ({ granted, sibling }) => {
    const store = memoryGrantStore();
    store.grant(granted, "read-write", 0);
    const svc = grantsService(store);
    const backend: DaemonBackend = { ...memoryBackend({ namespaces: [] }), ...svc };
    const handler = createDaemon(backend);

    const call = async (method: string, params: Record<string, unknown>) =>
      JSON.parse(await handleLine(encode({ id: 1, method, params } as never), handler));

    // grants.list reports the grant.
    const list = await call("grants.list", {});
    assertEquals(list.result[0].path, store.list()[0].path);

    // fs.write inside the grant succeeds and the bytes land on disk.
    const wrote = await call("fs.write", { path: `${granted}/report.md`, data: "hello" });
    assert(wrote.ok);
    assertEquals(wrote.result.bytes, 5);
    assertEquals(await Deno.readTextFile(`${granted}/report.md`), "hello");

    // fs.write to an ungranted sibling is an error frame — the write never happens.
    const denied = await call("fs.write", { path: `${sibling}/leak.md`, data: "x" });
    assert(!denied.ok);
    assert(denied.error.message.includes("no grant"));
  });
});
