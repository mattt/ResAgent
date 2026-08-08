/**
 * The engine-neutral operation model for the conformance harness (contracts C1/C2).
 *
 * A conformance case is a sequence of these standard Durable Object storage/alarm operations with
 * canonical expected results. The op set is the *specification* of storage semantics (C2): any
 * engine — the in-memory reference, workerd (the oracle), Celld, or the Swift core — must produce
 * the same result for the same op. Only the standard DO storage surface appears here (C1).
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export interface ListOptions {
  prefix?: string;
  /** Inclusive lower bound. */
  start?: string;
  /** Exclusive lower bound (mutually exclusive with `start`). */
  startAfter?: string;
  /** Exclusive upper bound. */
  end?: string;
  limit?: number;
  reverse?: boolean;
}

export type Op =
  | { kind: "put"; key: string; value: Json }
  | { kind: "get"; key: string }
  | { kind: "delete"; key: string }
  | { kind: "list"; options?: ListOptions }
  | { kind: "deleteAll" }
  | { kind: "setAlarm"; scheduledTime: number }
  | { kind: "getAlarm" }
  | { kind: "deleteAlarm" }
  // Batch variants of the standard DO storage API.
  | { kind: "putMany"; entries: Record<string, Json> }
  | { kind: "getMany"; keys: string[] }
  | { kind: "deleteMany"; keys: string[] };

/** Every op returns a JSON-serializable result so it compares identically across engines. */
export type OpResult = Json;
