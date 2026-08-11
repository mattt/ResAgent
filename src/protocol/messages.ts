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
  }
  | { id: number; method: "gate.rules"; params: Record<string, never> }
  | { id: number; method: "gate.log"; params: { limit?: number } }
  | {
    id: number;
    method: "automation.run";
    params: {
      target: string;
      kind: "shortcuts" | "osascript";
      name?: string;
      script?: string;
      input?: string;
    };
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
  "gate.rules",
  "gate.log",
  "automation.run",
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

/**
 * One egress-gate rule, flattened for the inspector's typed gate view (M6). Engine-neutral and
 * self-contained — the compiled gate policy lowered to a display row, read through the same C5 read
 * surface as storage and alarms so the inspector works against either engine.
 */
export interface GateRuleInfo {
  name: string;
  /** Host globs the rule's endpoint claims (empty for a global rule). */
  hosts: string[];
  /** Typed endpoint reference, e.g. `https.hf` (absent for a global rule). */
  endpoint?: string;
  /** CEL-subset condition, if any. */
  condition?: string;
  verdict: "allow" | "deny" | "approve" | "passthrough";
  /** Credential injected on an allow, if any. */
  credential?: string;
  priority: number;
  reason?: string;
}

/**
 * One logged egress-gate verdict, flattened for the inspector's Gate → Log view (M6). Recorded when
 * the gate evaluates an intercepted request; `finalVerdict`/`approver` are set when an approve
 * verdict is resolved through a verdict chain (M7), otherwise absent.
 */
export interface GateLogEntry {
  at: number;
  host: string;
  method?: string;
  path?: string;
  verdict: "allow" | "deny" | "approve" | "passthrough";
  /** Resolved verdict after an approver chain ran (M7). */
  finalVerdict?: "allow" | "deny";
  rule?: string;
  reason?: string;
  credential?: string;
  approver?: string;
}

/**
 * The result of running a Mac automation over the protocol (M9) — the first MUTATING method. Reports
 * whether the gate allowed it and, if so, the subprocess outcome. Backends that don't broker
 * automation omit `automationRun`, which the daemon answers with an error frame.
 */
export interface AutomationRunResult {
  ran: boolean;
  verdict: "allow" | "deny" | "approve" | "passthrough";
  code?: number;
  stdout?: string;
  stderr?: string;
  reason?: string;
}

export interface ResultByMethod {
  "status": DaemonStatus;
  "namespaces.list": NamespaceInfo[];
  "objects.list": ObjectInfo[];
  "storage.list": StorageEntries;
  "storage.get": Json;
  "alarms.get": number | null;
  "logs.tail": LogLine[];
  "gate.rules": GateRuleInfo[];
  "gate.log": GateLogEntry[];
  "automation.run": AutomationRunResult;
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
