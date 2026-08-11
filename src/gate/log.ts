/**
 * The egress-gate verdict log (M6 polish) — the write side of the inspector's Gate → Log view.
 *
 * `GateLog` is a bounded ring buffer of the verdicts the gate has emitted; `loggingGate` wraps any
 * {@link GateController} so every `evaluate` records its request + result; `toGateLogEntries` lowers
 * those records to the C5 {@link GateLogEntry} rows the daemon serves over `gate.log`. This is the
 * gate analog of the storage/alarms read surface: the shell views a live service, not a file.
 *
 * A record can carry a resolved `finalVerdict`/`approver` when an approve verdict runs through a
 * verdict chain (M7) — the resolver records the outcome; the base decorator records the raw verdict.
 */

import type { ActionFacts } from "./facts.ts";
import type { GateController, VerdictResult } from "./controller.ts";
import type { Policy } from "./policy.ts";
import type { GateLogEntry } from "../protocol/messages.ts";

export interface GateLogRecord {
  at: number;
  facts: ActionFacts;
  result: VerdictResult;
  /** Resolved verdict after an approver chain ran (M7). */
  finalVerdict?: "allow" | "deny";
  /** The approver that decided, if a chain ran. */
  approver?: string;
}

/** A bounded, newest-last ring buffer of gate verdicts. */
export class GateLog {
  readonly capacity: number;
  #buf: GateLogRecord[] = [];

  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  /** Append a record, evicting the oldest once capacity is exceeded. */
  record(rec: GateLogRecord): void {
    this.#buf.push(rec);
    if (this.#buf.length > this.capacity) this.#buf.shift();
  }

  /** The buffered records, oldest first; `limit` keeps only the most recent N. */
  entries(limit?: number): GateLogRecord[] {
    return limit === undefined ? [...this.#buf] : this.#buf.slice(-limit);
  }

  get size(): number {
    return this.#buf.length;
  }
}

/** Wrap a gate so every verdict is recorded to `log` (stamped with the wall clock). */
export function loggingGate(gate: GateController, log: GateLog): GateController {
  return {
    name: gate.name,
    applyPolicy: (policy: Policy) => gate.applyPolicy(policy),
    async evaluate(facts: ActionFacts): Promise<VerdictResult> {
      const result = await gate.evaluate(facts);
      log.record({ at: Date.now(), facts, result });
      return result;
    },
    close: gate.close ? () => gate.close!() : undefined,
  };
}

/** Lower gate-log records to the C5 wire rows the inspector renders. */
export function toGateLogEntries(records: GateLogRecord[]): GateLogEntry[] {
  return records.map((r) => {
    const e: GateLogEntry = { at: r.at, host: r.facts.host, verdict: r.result.verdict };
    if (r.facts.http?.method) e.method = r.facts.http.method;
    if (r.facts.http?.path) e.path = r.facts.http.path;
    if (r.result.rule) e.rule = r.result.rule;
    if (r.result.reason) e.reason = r.result.reason;
    if (r.result.credential) e.credential = r.result.credential;
    if (r.finalVerdict) e.finalVerdict = r.finalVerdict;
    if (r.approver) e.approver = r.approver;
    return e;
  });
}
