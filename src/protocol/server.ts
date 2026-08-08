/**
 * The daemon side of the control-plane ↔ daemon protocol (contract C5).
 *
 * `createDaemon` turns a {@link DaemonBackend} into a request handler; `serveConn` runs that handler
 * over an NDJSON stream (a Unix socket or stdio). The backend is injected — an in-memory one for
 * development/tests today ([memory_backend.ts](memory_backend.ts)), a Celld-backed one later — so
 * the wire protocol and its dispatch are testable without a running engine, exactly like the env.AI
 * seam. Decode failures become well-formed error frames rather than crashing the connection.
 */

import { decode, encode, ProtocolError } from "./codec.ts";
import type {
  DaemonStatus,
  Json,
  LogLine,
  NamespaceInfo,
  ObjectInfo,
  Request,
  Response,
  StorageEntries,
} from "./messages.ts";

export interface StorageListOptions {
  prefix?: string;
  limit?: number;
}

export interface LogsTailOptions {
  namespace?: string;
  objectId?: string;
  limit?: number;
}

/** What a daemon must be able to answer. Any engine (Celld, Swift, in-memory) implements this. */
export interface DaemonBackend {
  status(): Promise<DaemonStatus> | DaemonStatus;
  namespaces(): Promise<NamespaceInfo[]> | NamespaceInfo[];
  objects(namespace: string): Promise<ObjectInfo[]> | ObjectInfo[];
  storageList(
    namespace: string,
    objectId: string,
    opts: StorageListOptions,
  ): Promise<StorageEntries> | StorageEntries;
  storageGet(namespace: string, objectId: string, key: string): Promise<Json> | Json;
  alarmGet(namespace: string, objectId: string): Promise<number | null> | (number | null);
  logsTail(opts: LogsTailOptions): Promise<LogLine[]> | LogLine[];
}

async function dispatch(backend: DaemonBackend, req: Request): Promise<unknown> {
  switch (req.method) {
    case "status":
      return await backend.status();
    case "namespaces.list":
      return await backend.namespaces();
    case "objects.list":
      return await backend.objects(req.params.namespace);
    case "storage.list":
      return await backend.storageList(req.params.namespace, req.params.objectId, {
        prefix: req.params.prefix,
        limit: req.params.limit,
      });
    case "storage.get":
      return await backend.storageGet(
        req.params.namespace,
        req.params.objectId,
        req.params.key,
      );
    case "alarms.get":
      return await backend.alarmGet(req.params.namespace, req.params.objectId);
    case "logs.tail":
      return await backend.logsTail({
        namespace: req.params.namespace,
        objectId: req.params.objectId,
        limit: req.params.limit,
      });
  }
}

/** Build a request handler that answers each method from the backend. */
export function createDaemon(
  backend: DaemonBackend,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      return { id: req.id, ok: true, result: await dispatch(backend, req) };
    } catch (e) {
      return {
        id: req.id,
        ok: false,
        error: { code: "internal", message: (e as Error).message },
      };
    }
  };
}

/** Decode one frame, dispatch it, and encode the response — turning any decode error into a frame. */
export async function handleLine(
  line: string,
  handler: (req: Request) => Promise<Response>,
): Promise<string> {
  let msg;
  try {
    msg = decode(line);
  } catch (e) {
    const message = e instanceof ProtocolError ? e.message : "bad frame";
    return encode({ id: 0, ok: false, error: { code: "bad_request", message } });
  }
  if (!("method" in msg)) {
    return encode({
      id: msg.id,
      ok: false,
      error: { code: "bad_request", message: "expected a request" },
    });
  }
  return encode(await handler(msg));
}

/** Serve the protocol over an NDJSON byte stream (a Unix socket or stdio). */
export async function serveConn(
  conn: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  handler: (req: Request) => Promise<Response>,
): Promise<void> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const writer = conn.writable.getWriter();
  let buffer = "";
  try {
    for await (const chunk of conn.readable) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        await writer.write(encoder.encode(await handleLine(line, handler) + "\n"));
      }
    }
  } finally {
    await writer.close();
  }
}
