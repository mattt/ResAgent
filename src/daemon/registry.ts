/**
 * A persisted registry of the objects the celld-backed daemon has touched (M3 polish).
 *
 * The Durable Object model has no "list all instances" — an object exists once something addresses
 * it. So enumeration for the inspector is a registry: every object the daemon reads (storage, alarm)
 * is `touch()`ed into it, and `namespaces()`/`objects()` read it back. This is the honest, working
 * subset (full introspection would mean walking the S3 bucket — a follow-on under the object-store
 * inspector item). The store is JSON at ~/.resagent/registry.json, seeded with the flagship object
 * so the inspector opens onto something, and written atomically (tmp + rename) so a crash mid-write
 * never leaves a half file; a corrupt file recovers to the seed rather than throwing.
 */

export interface RegistryEntry {
  namespace: string;
  id: string;
  name: string;
}

export interface NamespaceCount {
  name: string;
  count: number;
}

/** The enumeration surface the celld backend reads and the daemon persists behind. */
export interface ObjectRegistry {
  /** Every registered object, in insertion order. */
  list(): RegistryEntry[];
  /** Objects in one namespace. */
  byNamespace(namespace: string): RegistryEntry[];
  /** Namespaces with their object counts. */
  namespaces(): NamespaceCount[];
  /** Record that an object was addressed; idempotent (keyed by namespace/id). Persists if changed. */
  touch(entry: RegistryEntry): void;
}

const keyOf = (ns: string, id: string) => `${ns}/${id}`;

/** An in-memory registry with an optional persistence hook, shared by the file and test variants. */
function makeRegistry(
  initial: RegistryEntry[],
  persist: (entries: RegistryEntry[]) => void,
): ObjectRegistry {
  // Preserve insertion order; dedupe by namespace/id.
  const byKey = new Map<string, RegistryEntry>();
  for (const e of initial) byKey.set(keyOf(e.namespace, e.id), e);

  return {
    list: () => [...byKey.values()],
    byNamespace: (namespace) =>
      [...byKey.values()].filter((e) => e.namespace === namespace),
    namespaces() {
      const counts = new Map<string, number>();
      for (const e of byKey.values()) {
        counts.set(e.namespace, (counts.get(e.namespace) ?? 0) + 1);
      }
      return [...counts].map(([name, count]) => ({ name, count }));
    },
    touch(entry) {
      const k = keyOf(entry.namespace, entry.id);
      const prev = byKey.get(k);
      if (prev && prev.name === entry.name) return; // already known, unchanged
      byKey.set(k, entry);
      persist([...byKey.values()]);
    },
  };
}

function readEntries(path: string): RegistryEntry[] | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return null; // no file yet
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null; // wrong shape → treat as absent, fall back to seed
    return parsed.filter((e): e is RegistryEntry =>
      e && typeof e.namespace === "string" && typeof e.id === "string" &&
      typeof e.name === "string"
    );
  } catch {
    return null; // corrupt file: recover to the seed rather than crash the daemon
  }
}

function writeEntries(path: string, entries: RegistryEntry[]): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) {
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch { /* exists */ }
  }
  // Atomic: write a sibling temp file and rename over the target so a reader never sees a partial.
  const tmp = `${path}.tmp-${Deno.pid}`;
  Deno.writeTextFileSync(tmp, JSON.stringify(entries, null, 2));
  Deno.renameSync(tmp, path);
}

/**
 * A file-backed {@link ObjectRegistry} at `path`. Loads existing entries if present; otherwise
 * starts from `seed` (and persists it). Corrupt files recover to `seed`.
 */
export function fileRegistry(path: string, seed: RegistryEntry[] = []): ObjectRegistry {
  const loaded = readEntries(path);
  const initial = loaded ?? seed;
  const reg = makeRegistry(initial, (entries) => writeEntries(path, entries));
  if (loaded === null && seed.length > 0) writeEntries(path, initial); // materialize the seed
  return reg;
}

/** An in-memory registry (tests, and engines that don't persist). */
export function memoryRegistry(seed: RegistryEntry[] = []): ObjectRegistry {
  return makeRegistry(seed, () => {});
}
