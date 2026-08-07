/**
 * The engine boundary the conformance harness drives (the C5 seam, generalized).
 *
 * "An engine" is anything that can stand up isolated Durable Object storage and apply ops to a
 * named object. The harness knows nothing else about it — so the same corpus validates the
 * in-memory reference, workerd (oracle), Celld, and the Swift core. Adapters live beside this file
 * (reference.ts today; workerd.ts scaffolded; celld/swift later).
 */

import type { Op, OpResult } from "./ops.ts";

export interface EngineInstance {
  /** Apply an op to object `objectId`'s storage and return its JSON result. */
  exec(objectId: string, op: Op): Promise<OpResult>;
  /** Release any resources (processes, temp dirs). */
  dispose(): Promise<void> | void;
}

export interface Engine {
  readonly name: string;
  /** Stand up a fresh instance with empty, isolated storage. */
  create(): Promise<EngineInstance>;
  /** Release engine-wide resources (e.g. a spawned workerd process). Optional. */
  close?(): Promise<void> | void;
}
