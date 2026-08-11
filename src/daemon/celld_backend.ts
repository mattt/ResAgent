/**
 * A Celld-backed DaemonBackend (M3) — the daemon serves REAL celld objects.
 *
 * Reuses the conformance harness's celld engine (MinIO + `celld deploy` of the op-executor + a
 * celld node) and forwards protocol reads to live objects: storage.list/get and alarms come
 * straight from an object's SQLite via the op-executor. Object *enumeration* is a registry of
 * objects the daemon has touched — the Durable Object model has no "list all instances", so a full
 * listing would mean introspecting the S3 bucket; the registry is the honest, working subset.
 *
 * Because it spawns celld + MinIO, the daemon needs run/net/read/write/sys permissions
 * (`deno task daemon:celld`). Celld v0.1.0 panics on setAlarm (see the conformance results), so the
 * seed sets no alarm and objects report hasAlarm:false.
 */

import { celldEngine, type CelldOptions } from "../conformance/celld.ts";
import type { EngineInstance } from "../conformance/engine.ts";
import type { DaemonBackend } from "../protocol/server.ts";
import type { Json, StorageEntries } from "../protocol/messages.ts";
import { fileRegistry, type ObjectRegistry, type RegistryEntry } from "./registry.ts";

export interface CelldBackendHandle {
  backend: DaemonBackend;
  close(): Promise<void>;
}

export interface CelldBackendOptions extends CelldOptions {
  /** Object-enumeration registry; defaults to a file registry seeded with the flagship object. */
  registry?: ObjectRegistry;
}

const SEED_OBJECT: RegistryEntry = {
  namespace: "research",
  id: "ResearchAgent",
  name: "ResearchAgent",
};

function defaultRegistry(): ObjectRegistry {
  const home = Deno.env.get("HOME") ?? ".";
  return fileRegistry(`${home}/.resagent/registry.json`, [SEED_OBJECT]);
}
const SEED_STORAGE: Record<string, Json> = {
  "cfg:topic": "on-device open-weights inference",
  "cfg:model": "HuggingFaceTB/SmolLM2-360M-Instruct",
  "findings": [{
    at: 1786200000000,
    summary: "celld serves live storage to the inspector.",
  }],
  "run:count": 1,
};

/** Route an object to its celld cell by a stable, namespace-qualified name. */
const cellId = (namespace: string, id: string) => `${namespace}/${id}`;

export async function celldBackend(
  opts: CelldBackendOptions = {},
): Promise<CelldBackendHandle> {
  const engine = celldEngine(opts);
  const instance: EngineInstance = await engine.create();
  const registry = opts.registry ?? defaultRegistry();
  registry.touch(SEED_OBJECT);

  // Any object the daemon addresses becomes enumerable — the DO model has no list-instances, so we
  // register on read. `id` doubles as the display name for objects discovered this way.
  const seen = (namespace: string, id: string) =>
    registry.touch({ namespace, id, name: id });

  // Seed one real object so the inspector opens onto live celld state.
  await instance.exec(cellId(SEED_OBJECT.namespace, SEED_OBJECT.id), {
    kind: "putMany",
    entries: SEED_STORAGE,
  });

  const backend: DaemonBackend = {
    status: () => ({ version: "0.1.0", engine: "celld", uptimeMs: 0 }),

    namespaces: () =>
      registry.namespaces().map((n) => ({ name: n.name, objectCount: n.count })),

    objects: (namespace) =>
      registry
        .byNamespace(namespace)
        .map((r) => ({ id: r.id, name: r.name, namespace, hasAlarm: false })),

    storageList: (namespace, id, opts) => {
      seen(namespace, id);
      return instance.exec(cellId(namespace, id), {
        kind: "list",
        options: { prefix: opts.prefix, limit: opts.limit },
      }) as Promise<StorageEntries>;
    },

    storageGet: (namespace, id, key) => {
      seen(namespace, id);
      return instance.exec(cellId(namespace, id), { kind: "get", key }) as Promise<Json>;
    },

    alarmGet: (namespace, id) => {
      seen(namespace, id);
      return instance.exec(cellId(namespace, id), { kind: "getAlarm" }) as Promise<
        number | null
      >;
    },

    logsTail: () => [],
  };

  return { backend, close: () => Promise.resolve(engine.close?.()) };
}
