/**
 * The op-executor Durable Object (contract C1) — the bridge that lets real engines run the corpus.
 *
 * A single, generic DO that receives one {@link Op} over HTTP and applies it to `ctx.storage`,
 * returning the same JSON shape the reference engine produces. Deployed once to workerd (oracle) or
 * Celld, it turns every data-driven case into an execution against a real engine. Uses only the
 * standard Durable Objects storage surface — nothing engine-specific (C1).
 */

/// <reference types="npm:@cloudflare/workers-types" />

import type { Json, ListOptions, Op, OpResult } from "./ops.ts";

export async function applyOp(storage: DurableObjectStorage, op: Op): Promise<OpResult> {
  switch (op.kind) {
    case "put":
      await storage.put(op.key, op.value);
      return null;
    case "get":
      return ((await storage.get<Json>(op.key)) ?? null);
    case "delete":
      return await storage.delete(op.key);
    case "deleteAll":
      await storage.deleteAll();
      return null;
    case "list": {
      const map = await storage.list<Json>(toListOptions(op.options));
      return [...map.entries()] as Json;
    }
    case "setAlarm":
      await storage.setAlarm(op.scheduledTime);
      return null;
    case "getAlarm":
      return (await storage.getAlarm());
    case "deleteAlarm":
      await storage.deleteAlarm();
      return null;
    case "putMany":
      await storage.put(op.entries);
      return null;
    case "getMany": {
      const map = await storage.get<Json>(op.keys);
      // Sort found pairs by key so the result compares identically across engines.
      return [...map.entries()].sort((
        a,
        b,
      ) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) as Json;
    }
    case "deleteMany":
      return await storage.delete(op.keys);
  }
}

function toListOptions(options: ListOptions = {}): DurableObjectListOptions {
  const out: DurableObjectListOptions = {};
  if (options.prefix !== undefined) out.prefix = options.prefix;
  if (options.start !== undefined) out.start = options.start;
  if (options.startAfter !== undefined) out.startAfter = options.startAfter;
  if (options.end !== undefined) out.end = options.end;
  if (options.limit !== undefined) out.limit = options.limit;
  if (options.reverse !== undefined) out.reverse = options.reverse;
  return out;
}

export class OpExecutor implements DurableObject {
  constructor(private ctx: DurableObjectState) {}

  /** Required: engines refuse setAlarm() unless the class defines an alarm() handler. */
  alarm(): void {}

  async fetch(req: Request): Promise<Response> {
    const op = await req.json() as Op;
    const result = await applyOp(this.ctx.storage, op);
    return Response.json({ result });
  }
}
