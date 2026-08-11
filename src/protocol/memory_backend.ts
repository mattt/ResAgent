/**
 * An in-memory {@link DaemonBackend} (contract C5).
 *
 * Serves the protocol from seed data with no engine behind it — the fake the Deno Desktop shell and
 * inspector develop against before the Celld-backed daemon exists, and the fixture the server tests
 * run on. The Celld backend implements the same interface later.
 */

import type {
  DaemonBackend,
  GateLogOptions,
  LogsTailOptions,
  StorageListOptions,
} from "./server.ts";
import type {
  DaemonStatus,
  FolderGrantInfo,
  GateLogEntry,
  GateRuleInfo,
  Json,
  LogLine,
  NamespaceInfo,
  ObjectInfo,
  StorageEntries,
} from "./messages.ts";

export interface MemoryObject {
  id: string;
  name: string;
  storage?: Record<string, Json>;
  alarm?: number | null;
}

export interface MemoryNamespace {
  name: string;
  objects: MemoryObject[];
}

export interface MemorySeed {
  version?: string;
  engine?: string;
  uptimeMs?: number;
  namespaces: MemoryNamespace[];
  logs?: LogLine[];
  gate?: GateRuleInfo[];
  gateLog?: GateLogEntry[];
  grants?: FolderGrantInfo[];
}

export function memoryBackend(seed: MemorySeed): DaemonBackend {
  const find = (ns: string, id: string): MemoryObject | undefined =>
    seed.namespaces.find((n) => n.name === ns)?.objects.find((o) => o.id === id);

  return {
    status(): DaemonStatus {
      return {
        version: seed.version ?? "0.0.0",
        engine: seed.engine ?? "memory",
        uptimeMs: seed.uptimeMs ?? 0,
      };
    },

    namespaces(): NamespaceInfo[] {
      return seed.namespaces.map((n) => ({
        name: n.name,
        objectCount: n.objects.length,
      }));
    },

    objects(namespace: string): ObjectInfo[] {
      const ns = seed.namespaces.find((n) => n.name === namespace);
      return (ns?.objects ?? []).map((o) => ({
        id: o.id,
        name: o.name,
        namespace,
        hasAlarm: (o.alarm ?? null) !== null,
      }));
    },

    storageList(
      namespace: string,
      objectId: string,
      opts: StorageListOptions,
    ): StorageEntries {
      const store = find(namespace, objectId)?.storage ?? {};
      let keys = Object.keys(store);
      if (opts.prefix !== undefined) {
        keys = keys.filter((k) => k.startsWith(opts.prefix!));
      }
      keys.sort();
      if (opts.limit !== undefined) keys = keys.slice(0, opts.limit);
      return keys.map((k) => [k, store[k]] as [string, Json]);
    },

    storageGet(namespace: string, objectId: string, key: string): Json {
      const store = find(namespace, objectId)?.storage ?? {};
      return key in store ? store[key] : null;
    },

    alarmGet(namespace: string, objectId: string): number | null {
      return find(namespace, objectId)?.alarm ?? null;
    },

    logsTail(opts: LogsTailOptions): LogLine[] {
      let logs = seed.logs ?? [];
      if (opts.namespace !== undefined) {
        logs = logs.filter((l) => l.namespace === opts.namespace);
      }
      if (opts.objectId !== undefined) {
        logs = logs.filter((l) => l.objectId === opts.objectId);
      }
      if (opts.limit !== undefined) logs = logs.slice(-opts.limit);
      return logs;
    },

    gateRules(): GateRuleInfo[] {
      return seed.gate ?? [];
    },

    gateLog(opts: GateLogOptions): GateLogEntry[] {
      const log = seed.gateLog ?? [];
      return opts.limit !== undefined ? log.slice(-opts.limit) : log;
    },

    grantsList(): FolderGrantInfo[] {
      return seed.grants ?? [];
    },
  };
}
