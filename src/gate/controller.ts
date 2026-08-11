/**
 * The gate boundary (M6). Every gate backend implements this — the in-process {@link
 * "./reference.ts".ReferenceGate} (CI truth-for-dev) and the real {@link
 * "./clawpatrol.ts".ClawPatrolGate} (measured against it). The control plane and the corpus runner
 * talk to a `GateController`, never to a specific gate, so the gate is swappable exactly as the
 * storage engine (C2) and the daemon backend (C5) are.
 */

import type { ActionFacts } from "./facts.ts";
import type { Policy, Verdict } from "./policy.ts";

export interface VerdictResult {
  verdict: Verdict;
  /** Name of the rule that fired, if any. */
  rule?: string;
  /** Typed endpoint reference the request matched, e.g. `https.hf`. */
  endpoint?: string;
  reason?: string;
  /** Credential the gate would inject at the wire (allow verdicts only). */
  credential?: string;
  /** Approvers an `approve` verdict escalates to, in chain order (M7). */
  approvers?: string[];
}

export interface GateController {
  readonly name: string;
  /** Load a policy; replaces any previously applied one. */
  applyPolicy(policy: Policy): Promise<void>;
  /** Judge one intercepted request. */
  evaluate(facts: ActionFacts): Promise<VerdictResult>;
  /** Release any resources (subprocesses, temp dirs). Optional. */
  close?(): Promise<void>;
}
