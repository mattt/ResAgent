/**
 * Golden + round-trip tests for the control-plane ↔ daemon protocol (contract C5).
 *
 * The golden strings pin the canonical wire form: if the framing or a message shape drifts, these
 * fail. Round-trip tests confirm decode is the inverse of encode, and the validation tests confirm
 * malformed frames are rejected rather than silently accepted.
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  canonicalize,
  decode,
  encode,
  frame,
  parseFrames,
  ProtocolError,
} from "./codec.ts";
import type { Message, Request, Response } from "./messages.ts";

// Canonical golden wire forms — keys sorted at every level, undefined omitted.
const GOLDEN: [Message, string][] = [
  [
    { id: 1, method: "status", params: {} },
    `{"id":1,"method":"status","params":{}}`,
  ],
  [
    { id: 2, method: "objects.list", params: { namespace: "research" } },
    `{"id":2,"method":"objects.list","params":{"namespace":"research"}}`,
  ],
  [
    {
      id: 3,
      method: "storage.list",
      params: { namespace: "research", objectId: "A", limit: 10 },
    },
    `{"id":3,"method":"storage.list","params":{"limit":10,"namespace":"research","objectId":"A"}}`,
  ],
  [
    { id: 4, ok: true, result: [{ name: "research", objectCount: 2 }] },
    `{"id":4,"ok":true,"result":[{"name":"research","objectCount":2}]}`,
  ],
  [
    { id: 6, method: "gate.log", params: { limit: 50 } },
    `{"id":6,"method":"gate.log","params":{"limit":50}}`,
  ],
  [
    {
      id: 7,
      method: "automation.run",
      params: { target: "research/ResearchAgent", kind: "osascript", script: "1+1" },
    },
    `{"id":7,"method":"automation.run","params":{"kind":"osascript","script":"1+1","target":"research/ResearchAgent"}}`,
  ],
  [
    { id: 8, method: "grants.list", params: {} },
    `{"id":8,"method":"grants.list","params":{}}`,
  ],
  [
    {
      id: 9,
      method: "fs.write",
      params: { path: "~/ResAgent/research/out.md", data: "hi" },
    },
    `{"id":9,"method":"fs.write","params":{"data":"hi","path":"~/ResAgent/research/out.md"}}`,
  ],
  [
    { id: 5, ok: false, error: { code: "not_found", message: "no object" } },
    `{"error":{"code":"not_found","message":"no object"},"id":5,"ok":false}`,
  ],
];

Deno.test("encode produces the canonical golden wire form", () => {
  for (const [msg, wire] of GOLDEN) assertEquals(encode(msg), wire);
});

Deno.test("decode is the inverse of encode (round-trip)", () => {
  for (const [msg] of GOLDEN) assertEquals(decode(encode(msg)), msg);
});

Deno.test("canonicalize sorts keys and omits undefined", () => {
  assertEquals(canonicalize({ b: 1, a: 2 }), `{"a":2,"b":1}`);
  const req: Request = {
    id: 9,
    method: "storage.list",
    params: { namespace: "n", objectId: "o", prefix: undefined },
  };
  // prefix is undefined → omitted entirely from the wire form.
  assertEquals(
    encode(req),
    `{"id":9,"method":"storage.list","params":{"namespace":"n","objectId":"o"}}`,
  );
});

Deno.test("frame/parseFrames handle multiple messages and a partial tail", () => {
  const a = frame(GOLDEN[0][0]);
  const b = frame(GOLDEN[3][0]);
  const partial = encode(GOLDEN[4][0]); // no trailing newline
  const { messages, rest } = parseFrames(a + b + partial);
  assertEquals(messages.length, 2);
  assertEquals(messages[0], GOLDEN[0][0]);
  assertEquals(messages[1], GOLDEN[3][0]);
  assertEquals(rest, partial);
  // The leftover completes on the next chunk.
  assertEquals(parseFrames(rest + "\n").messages[0], GOLDEN[4][0]);
});

Deno.test("decode rejects malformed frames", () => {
  assertThrows(() => decode("not json"), ProtocolError, "valid JSON");
  assertThrows(() => decode(`[1,2,3]`), ProtocolError, "JSON object");
  assertThrows(() => decode(`{"method":"status","params":{}}`), ProtocolError, "`id`");
  assertThrows(
    () => decode(`{"id":1,"method":"nope","params":{}}`),
    ProtocolError,
    "unknown method",
  );
  assertThrows(() => decode(`{"id":1,"method":"status"}`), ProtocolError, "`params`");
  assertThrows(() => decode(`{"id":1}`), ProtocolError, "neither a request");
  assertThrows(
    () => decode(`{"id":1,"ok":false}`),
    ProtocolError,
    "error.{code,message}",
  );
});

Deno.test("decoded responses keep their correlation id", () => {
  const res = decode(`{"id":42,"ok":true,"result":null}`) as Response;
  assertEquals(res.id, 42);
  assert(res.ok);
});
