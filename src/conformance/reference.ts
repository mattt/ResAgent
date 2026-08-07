/**
 * The in-memory reference engine.
 *
 * Implements the standard Durable Object storage + alarm semantics directly, with no JS host and no
 * FFI — so the harness and its corpus are developable and CI-green without any download. It is the
 * "run against a stub" substrate from the plan's H0, and it cross-checks the corpus: a case the
 * reference engine passes is a well-formed case. It is NOT the oracle for judging Celld — that is
 * workerd (see workerd.ts). Keys sort in lexicographic (UTF-16 code-unit) order; keep corpus keys
 * ASCII, where that coincides with Durable Objects' byte order.
 */

import type { Engine, EngineInstance } from "./engine.ts";
import type { Json, ListOptions, Op, OpResult } from "./ops.ts";

class ReferenceInstance implements EngineInstance {
  readonly #stores = new Map<string, Map<string, Json>>();
  readonly #alarms = new Map<string, number>();

  #store(objectId: string): Map<string, Json> {
    let s = this.#stores.get(objectId);
    if (!s) {
      s = new Map();
      this.#stores.set(objectId, s);
    }
    return s;
  }

  exec(objectId: string, op: Op): Promise<OpResult> {
    const store = this.#store(objectId);
    switch (op.kind) {
      case "put":
        store.set(op.key, op.value);
        return Promise.resolve(null);
      case "get":
        return Promise.resolve(store.has(op.key) ? store.get(op.key)! : null);
      case "delete":
        return Promise.resolve(store.delete(op.key));
      case "deleteAll":
        store.clear();
        return Promise.resolve(null);
      case "list":
        return Promise.resolve(this.#list(store, op.options ?? {}));
      case "setAlarm":
        this.#alarms.set(objectId, op.scheduledTime);
        return Promise.resolve(null);
      case "getAlarm":
        return Promise.resolve(
          this.#alarms.has(objectId) ? this.#alarms.get(objectId)! : null,
        );
      case "deleteAlarm":
        // Durable Objects' deleteAlarm() returns void (unlike delete(key), which returns boolean).
        this.#alarms.delete(objectId);
        return Promise.resolve(null);
    }
  }

  #list(store: Map<string, Json>, options: ListOptions): Json {
    let keys = [...store.keys()];
    if (options.prefix !== undefined) {
      keys = keys.filter((k) => k.startsWith(options.prefix!));
    }
    keys.sort();
    if (options.reverse) keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    return keys.map((k) => [k, store.get(k)!] as Json);
  }

  dispose(): void {}
}

export const referenceEngine: Engine = {
  name: "reference",
  create: () => Promise.resolve(new ReferenceInstance()),
};
