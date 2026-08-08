/**
 * The control-plane ↔ daemon protocol (contract C5).
 *
 * One internal protocol: the Deno Desktop shell (control plane, inspector, log viewer) is a client
 * of a single framed request/response protocol to the ResAgent daemon. The app is a viewer over a
 * service — so the service keeps running when the app quits, and the same protocol drives either
 * engine (Celld or the Swift core). These are the typed frames; codec.ts is the wire format and
 * protocol_test.ts pins it with golden tests.
 *
 * Requests defined here are the inspector's read surface (the ResEdit-style views); mutating methods
 * (deploy, gate edits) extend the same envelope later.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

// ── Requests ─────────────────────────────────────────────────────────────────

export type Request =
  | { id: number; method: "status"; params: Record<string, never> }
  | { id: number; method: "namespaces.list"; params: Record<string, never> }
  | { id: number; method: "objects.list"; params: { namespace: string } }
  | {
    id: number;
    method: "storage.list";
    params: { namespace: string; objectId: string; prefix?: string; limit?: number };
  }
  | {
    id: number;
    method: "storage.get";
    params: { namespace: string; objectId: string; key: string };
  }
  | { id: number; method: "alarms.get"; params: { namespace: string; objectId: string } }
  | {
    id: number;
    method: "logs.tail";
    params: { namespace?: string; objectId?: string; limit?: number };
  };

export type Method = Request["method"];

export const METHODS: readonly Method[] = [
  "status",
  "namespaces.list",
  "objects.list",
  "storage.list",
  "storage.get",
  "alarms.get",
  "logs.tail",
] as const;

// ── Result payloads (by method) ──────────────────────────────────────────────

export interface DaemonStatus {
  version: string;
  engine: string;
  uptimeMs: number;
}

export interface NamespaceInfo {
  name: string;
  objectCount: number;
}

export interface ObjectInfo {
  id: string;
  name: string;
  namespace: string;
  hasAlarm: boolean;
}

/** Storage view as sorted [key, value] pairs (the inspector's per-object resource fork). */
export type StorageEntries = [string, Json][];

export interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  namespace?: string;
  objectId?: string;
  message: string;
}

export interface ResultByMethod {
  "status": DaemonStatus;
  "namespaces.list": NamespaceInfo[];
  "objects.list": ObjectInfo[];
  "storage.list": StorageEntries;
  "storage.get": Json;
  "alarms.get": number | null;
  "logs.tail": LogLine[];
}

// ── Responses ────────────────────────────────────────────────────────────────

export interface Ok<T> {
  id: number;
  ok: true;
  result: T;
}

export interface Err {
  id: number;
  ok: false;
  error: { code: string; message: string };
}

export type Response = Ok<unknown> | Err;

export type Message = Request | Response;
