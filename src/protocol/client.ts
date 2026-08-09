/**
 * The control-plane side of the protocol (contract C5) — the client the shell/inspector use.
 *
 * Wraps a duplex byte stream (a Unix socket / stdio to the daemon), sends typed requests with
 * auto-incrementing ids, and correlates each response back to its caller by id. Together with
 * server.ts this closes the request/response loop; client_test.ts drives a real client against the
 * real daemon over an in-memory stream pair.
 */

import { decode, encode } from "./codec.ts";
import type {
  DaemonStatus,
  Json,
  LogLine,
  NamespaceInfo,
  ObjectInfo,
  Request,
  StorageEntries,
} from "./messages.ts";
import type { LogsTailOptions, StorageListOptions } from "./server.ts";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface Duplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export class ProtocolClient {
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #readTask: Promise<void>;
  #closed = false;

  constructor(conn: Duplex) {
    this.#writer = conn.writable.getWriter();
    this.#readTask = this.#readLoop(conn.readable);
  }

  async #readLoop(readable: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of readable) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) this.#onFrame(line);
        }
      }
    } catch {
      // The connection was torn down mid-read — expected on close; pending calls fail below.
    } finally {
      this.#failAll(new Error("connection closed"));
    }
  }

  #onFrame(line: string): void {
    const msg = decode(line);
    if (!("ok" in msg)) return; // ignore stray requests on the client side
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
  }

  #failAll(err: Error): void {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  #call<T>(method: Request["method"], params: Record<string, unknown>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("client is closed"));
    const id = this.#nextId++;
    const line = encode({ id, method, params } as Request) + "\n";
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.#writer.write(this.#encoder.encode(line)).catch((e) => {
      const p = this.#pending.get(id);
      if (p) {
        this.#pending.delete(id);
        p.reject(e as Error);
      }
    });
    return promise;
  }

  status(): Promise<DaemonStatus> {
    return this.#call("status", {});
  }
  namespaces(): Promise<NamespaceInfo[]> {
    return this.#call("namespaces.list", {});
  }
  objects(namespace: string): Promise<ObjectInfo[]> {
    return this.#call("objects.list", { namespace });
  }
  storageList(
    namespace: string,
    objectId: string,
    opts: StorageListOptions = {},
  ): Promise<StorageEntries> {
    return this.#call("storage.list", { namespace, objectId, ...opts });
  }
  storageGet(namespace: string, objectId: string, key: string): Promise<Json> {
    return this.#call("storage.get", { namespace, objectId, key });
  }
  alarmGet(namespace: string, objectId: string): Promise<number | null> {
    return this.#call("alarms.get", { namespace, objectId });
  }
  logsTail(opts: LogsTailOptions = {}): Promise<LogLine[]> {
    return this.#call("logs.tail", { ...opts });
  }

  async close(): Promise<void> {
    this.#closed = true;
    try {
      await this.#writer.close();
    } catch { /* already closing */ }
    await this.#readTask;
  }
}
