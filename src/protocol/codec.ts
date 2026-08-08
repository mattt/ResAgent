/**
 * Wire codec for the control-plane ↔ daemon protocol (contract C5).
 *
 * Frames are newline-delimited JSON (NDJSON) over a local socket/stdio. `encode` produces a
 * CANONICAL form — object keys sorted, undefined omitted — so a given message always serializes to
 * the same bytes; that determinism is what the golden tests pin. `decode` validates the frame shape
 * and rejects anything that isn't a well-formed request or response.
 */

import { type Message, METHODS, type Request, type Response } from "./messages.ts";

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Deterministic JSON: keys sorted at every level, undefined values omitted. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** Encode a message to its canonical single-line wire form (no trailing newline). */
export function encode(msg: Message): string {
  return canonicalize(msg);
}

/** Encode a message as a complete NDJSON frame (with trailing newline). */
export function frame(msg: Message): string {
  return encode(msg) + "\n";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decode and validate a single frame (one line, no newline required). */
export function decode(line: string): Message {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolError("frame is not valid JSON");
  }
  if (!isObject(parsed)) throw new ProtocolError("frame must be a JSON object");
  if (typeof parsed.id !== "number") {
    throw new ProtocolError("frame missing numeric `id`");
  }

  if ("method" in parsed) return validateRequest(parsed);
  if ("ok" in parsed) return validateResponse(parsed);
  throw new ProtocolError("frame is neither a request (`method`) nor a response (`ok`)");
}

function validateRequest(f: Record<string, unknown>): Request {
  if (typeof f.method !== "string" || !METHODS.includes(f.method as Request["method"])) {
    throw new ProtocolError(`unknown method: ${JSON.stringify(f.method)}`);
  }
  if (!isObject(f.params)) throw new ProtocolError("request missing `params` object");
  return f as unknown as Request;
}

function validateResponse(f: Record<string, unknown>): Response {
  if (typeof f.ok !== "boolean") throw new ProtocolError("response `ok` must be boolean");
  if (f.ok) {
    if (!("result" in f)) throw new ProtocolError("ok response missing `result`");
  } else {
    const e = f.error;
    if (!isObject(e) || typeof e.code !== "string" || typeof e.message !== "string") {
      throw new ProtocolError("error response needs error.{code,message}");
    }
  }
  return f as unknown as Response;
}

/**
 * Split a buffer of accumulated bytes into complete frames, returning the decoded messages and the
 * leftover partial line. Use across chunked reads from a socket.
 */
export function parseFrames(buffer: string): { messages: Message[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const messages = parts.filter((l) => l.length > 0).map(decode);
  return { messages, rest };
}
