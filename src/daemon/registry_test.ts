/**
 * The object-enumeration registry (M3 polish): round-trip persistence, idempotent upsert, namespace
 * counts, and corrupt-file recovery. CI-safe — a temp file, no engine.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { fileRegistry, memoryRegistry, type RegistryEntry } from "./registry.ts";

const SEED: RegistryEntry = {
  namespace: "research",
  id: "ResearchAgent",
  name: "ResearchAgent",
};

async function withTempFile(
  fn: (path: string) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "resagent-registry-" });
  try {
    await fn(`${dir}/registry.json`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("memory registry: touch is idempotent and counts by namespace", () => {
  const reg = memoryRegistry([SEED]);
  reg.touch(SEED); // same entry — no growth
  reg.touch({ namespace: "research", id: "TriageAgent", name: "TriageAgent" });
  reg.touch({ namespace: "family", id: "chore-board", name: "chore-board" });

  assertEquals(reg.list().length, 3);
  assertEquals(reg.byNamespace("research").map((e) => e.id), [
    "ResearchAgent",
    "TriageAgent",
  ]);
  assertEquals(
    reg.namespaces().sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "family", count: 1 }, { name: "research", count: 2 }],
  );
});

Deno.test("file registry: seeds a fresh path and persists across reopen", async () => {
  await withTempFile((path) => {
    const first = fileRegistry(path, [SEED]);
    first.touch({ namespace: "research", id: "TriageAgent", name: "TriageAgent" });

    // A second registry over the same path sees the persisted state, not the seed.
    const reopened = fileRegistry(path, [SEED]);
    assertEquals(reopened.list().length, 2);
    assert(reopened.byNamespace("research").some((e) => e.id === "TriageAgent"));
  });
});

Deno.test("file registry: upsert updates the display name in place", async () => {
  await withTempFile((path) => {
    const reg = fileRegistry(path);
    reg.touch({ namespace: "n", id: "o", name: "Old" });
    reg.touch({ namespace: "n", id: "o", name: "New" });
    assertEquals(reg.list().length, 1);
    assertEquals(reg.list()[0].name, "New");
    assertEquals(fileRegistry(path).list()[0].name, "New");
  });
});

Deno.test("file registry: a corrupt file recovers to the seed", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(path, "{ not json");
    // A corrupt file is treated as absent: recover to the seed and re-materialize it on disk.
    const reg = fileRegistry(path, [SEED]);
    assertEquals(reg.list(), [SEED]);
    assertEquals(fileRegistry(path).list(), [SEED]);
  });
});
