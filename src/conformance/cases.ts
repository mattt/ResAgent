/**
 * The conformance corpus — the storage/alarm specification as data (contract C2).
 *
 * Each case is a fresh, isolated instance and a sequence of ops with the canonical expected result.
 * These expectations ARE the spec; the reference engine is checked against them, workerd (the
 * oracle) confirms they are correct, and Celld/Swift are measured against them. Keep keys ASCII so
 * lexicographic order matches Durable Objects' byte order.
 */

import type { Json, Op } from "./ops.ts";

export interface Step {
  /** Object to route to (defaults to the case's `object`, else "A"). */
  object?: string;
  op: Op;
  expect: Json;
}

export interface Case {
  name: string;
  description: string;
  object?: string;
  steps: Step[];
}

export const cases: Case[] = [
  {
    name: "put/get roundtrip",
    description: "a stored value reads back unchanged; missing keys read as null",
    steps: [
      { op: { kind: "get", key: "x" }, expect: null },
      { op: { kind: "put", key: "x", value: { n: 1 } }, expect: null },
      { op: { kind: "get", key: "x" }, expect: { n: 1 } },
    ],
  },
  {
    name: "overwrite",
    description: "a second put replaces the first value",
    steps: [
      { op: { kind: "put", key: "k", value: 1 }, expect: null },
      { op: { kind: "put", key: "k", value: 2 }, expect: null },
      { op: { kind: "get", key: "k" }, expect: 2 },
    ],
  },
  {
    name: "delete semantics",
    description: "delete returns whether the key existed; the key is gone afterward",
    steps: [
      { op: { kind: "put", key: "k", value: "v" }, expect: null },
      { op: { kind: "delete", key: "k" }, expect: true },
      { op: { kind: "get", key: "k" }, expect: null },
      { op: { kind: "delete", key: "k" }, expect: false },
    ],
  },
  {
    name: "list: sorted + prefix",
    description: "list returns [key, value] pairs sorted by key, filtered by prefix",
    steps: [
      { op: { kind: "put", key: "user:2", value: "b" }, expect: null },
      { op: { kind: "put", key: "user:1", value: "a" }, expect: null },
      { op: { kind: "put", key: "post:1", value: "p" }, expect: null },
      {
        op: { kind: "list", options: { prefix: "user:" } },
        expect: [["user:1", "a"], ["user:2", "b"]],
      },
    ],
  },
  {
    name: "list: reverse + limit",
    description: "reverse sorts descending; limit caps the count",
    steps: [
      { op: { kind: "put", key: "a", value: 1 }, expect: null },
      { op: { kind: "put", key: "b", value: 2 }, expect: null },
      { op: { kind: "put", key: "c", value: 3 }, expect: null },
      {
        op: { kind: "list", options: { reverse: true, limit: 2 } },
        expect: [["c", 3], ["b", 2]],
      },
    ],
  },
  {
    name: "deleteAll",
    description: "deleteAll empties the store",
    steps: [
      { op: { kind: "put", key: "a", value: 1 }, expect: null },
      { op: { kind: "put", key: "b", value: 2 }, expect: null },
      { op: { kind: "deleteAll" }, expect: null },
      { op: { kind: "list" }, expect: [] },
    ],
  },
  {
    name: "per-object isolation",
    description: "each Durable Object has private storage; B cannot see A's data",
    steps: [
      { object: "A", op: { kind: "put", key: "k", value: "vA" }, expect: null },
      { object: "B", op: { kind: "get", key: "k" }, expect: null },
      { object: "A", op: { kind: "get", key: "k" }, expect: "vA" },
    ],
  },
  {
    name: "alarm set/get/delete",
    description:
      "alarm state stores a scheduled time and can be read and cleared (delete is void)",
    // Constraints the workerd oracle enforces: the class must define an alarm() handler, and the
    // time must be before ~2189 and in the future (a past time fires immediately). 2100-01-01 is a
    // safe fixed future time that never fires during a test.
    steps: [
      { op: { kind: "getAlarm" }, expect: null },
      { op: { kind: "setAlarm", scheduledTime: 4102444800000 }, expect: null },
      { op: { kind: "getAlarm" }, expect: 4102444800000 },
      { op: { kind: "deleteAlarm" }, expect: null },
      { op: { kind: "getAlarm" }, expect: null },
    ],
  },
  {
    name: "batch put/get",
    description:
      "putMany writes entries; getMany returns found keys as sorted pairs, omitting misses",
    steps: [
      { op: { kind: "putMany", entries: { a: 1, b: 2, c: 3 } }, expect: null },
      { op: { kind: "getMany", keys: ["c", "a", "zzz"] }, expect: [["a", 1], ["c", 3]] },
      { op: { kind: "list" }, expect: [["a", 1], ["b", 2], ["c", 3]] },
    ],
  },
  {
    name: "batch delete",
    description: "deleteMany returns the count of keys that existed",
    steps: [
      { op: { kind: "putMany", entries: { a: 1, b: 2, c: 3 } }, expect: null },
      { op: { kind: "deleteMany", keys: ["a", "c", "nope"] }, expect: 2 },
      { op: { kind: "list" }, expect: [["b", 2]] },
    ],
  },
  {
    name: "list: start + end range",
    description: "start is inclusive, end is exclusive",
    steps: [
      {
        op: { kind: "putMany", entries: { k1: 1, k2: 2, k3: 3, k4: 4, k5: 5 } },
        expect: null,
      },
      {
        op: { kind: "list", options: { start: "k2", end: "k4" } },
        expect: [["k2", 2], ["k3", 3]],
      },
    ],
  },
  {
    name: "list: startAfter + reverse + limit",
    description:
      "startAfter is exclusive; reverse then limit apply to the selected range",
    steps: [
      { op: { kind: "putMany", entries: { a: 1, b: 2, c: 3, d: 4 } }, expect: null },
      {
        op: { kind: "list", options: { startAfter: "a", reverse: true, limit: 2 } },
        expect: [["d", 4], ["c", 3]],
      },
    ],
  },
];
