/**
 * Verdict-chain approvers (M7) — the layer above the gate that resolves an `approve` verdict to a
 * final allow/deny.
 *
 * The gate ({@link "./reference.ts".ReferenceGate}, real Claw Patrol) emits a STATIC verdict:
 * allow / deny / approve. `approve` means "a human-or-model must decide" — that decision is here, so
 * the gate stays simple and its fixtures keep comparing static verdicts. Two approvers:
 *
 *  - {@link RuleBasedApprover}: deterministic, decides from a CEL-subset `allowWhen` — CI-green, and
 *    the fallback the demo/corpus use when no model is running.
 *  - {@link LlmApprover}: asks an on-device OpenAI-compatible model (contract C3) ALLOW/DENY with a
 *    rationale; unreachable / non-OK / unrecognized reply ⇒ deny (deny-closed).
 *
 * {@link resolveVerdict} runs the chain: a non-approve verdict passes through (allow/passthrough →
 * allow, anything else → deny); an `approve` runs its approvers as an AND-chain with first-deny
 * short-circuit, and an approve with no/unknown approver denies closed.
 */

import type { ActionFacts } from "./facts.ts";
import type { VerdictResult } from "./controller.ts";
import type { ApproverSpec } from "./policy.ts";
import { evaluateCondition } from "./cel.ts";

export type Decision = "allow" | "deny";

export interface ApproverDecision {
  decision: Decision;
  rationale?: string;
}

export interface Approver {
  readonly name: string;
  review(facts: ActionFacts): Promise<ApproverDecision>;
}

/** A deterministic approver: `allowWhen` (CEL) holds ⇒ allow, else deny. Absent ⇒ deny-closed. */
export class RuleBasedApprover implements Approver {
  readonly name: string;
  #allowWhen?: string;

  constructor(spec: ApproverSpec) {
    this.name = spec.name;
    this.#allowWhen = spec.allowWhen;
  }

  review(facts: ActionFacts): Promise<ApproverDecision> {
    if (!this.#allowWhen) {
      return Promise.resolve({
        decision: "deny",
        rationale: "no allow_when — deny-closed",
      });
    }
    const held = evaluateCondition(this.#allowWhen, facts);
    return Promise.resolve({
      decision: held ? "allow" : "deny",
      rationale: `allow_when ${held ? "held" : "failed"}`,
    });
  }
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:8788";
const DEFAULT_PROMPT =
  "You are an egress reviewer for an autonomous agent. Given the request, reply with ALLOW or " +
  "DENY on the first line, then a one-line rationale. Deny anything risky or ambiguous.";

/** Ask an on-device OpenAI-compatible model to adjudicate. Deny-closed on any failure. */
export class LlmApprover implements Approver {
  readonly name: string;
  #endpoint: string;
  #model: string;
  #prompt: string;

  constructor(spec: ApproverSpec) {
    this.name = spec.name;
    this.#endpoint = spec.endpoint ?? DEFAULT_ENDPOINT;
    this.#model = spec.model ?? "local";
    this.#prompt = spec.prompt ?? DEFAULT_PROMPT;
  }

  async review(facts: ActionFacts): Promise<ApproverDecision> {
    let text: string;
    try {
      const res = await fetch(`${this.#endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.#model,
          temperature: 0,
          messages: [
            { role: "system", content: this.#prompt },
            { role: "user", content: describeRequest(facts) },
          ],
        }),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return { decision: "deny", rationale: `approver HTTP ${res.status}` };
      }
      const data = await res.json() as {
        choices?: { message?: { content?: string } }[];
      };
      text = data.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      return {
        decision: "deny",
        rationale: `approver unreachable: ${(e as Error).message}`,
      };
    }
    return parseDecision(text);
  }
}

/** Render one request as the reviewer's user turn. */
export function describeRequest(facts: ActionFacts): string {
  const h = facts.http;
  const line = h
    ? `${h.method} https://${facts.host}${h.path}`
    : `connect to ${facts.host}`;
  return `An autonomous agent wants to make this egress request:\n\n  ${line}\n\n` +
    `Should it be allowed? Reply ALLOW or DENY with a one-line rationale.`;
}

/** Parse a model reply: leading ALLOW/DENY wins; anything else denies closed. */
export function parseDecision(text: string): ApproverDecision {
  const trimmed = text.trim();
  const first = (trimmed.match(/[A-Za-z]+/)?.[0] ?? "").toUpperCase();
  const rationale = trimmed.replace(/^[^A-Za-z]*(ALLOW|DENY)\b[:.\-\s]*/i, "").trim() ||
    undefined;
  if (first === "ALLOW") return { decision: "allow", rationale };
  if (first === "DENY") return { decision: "deny", rationale };
  return { decision: "deny", rationale: "unrecognized approver reply — deny-closed" };
}

/** Instantiate an approver from its spec. */
export function makeApprover(spec: ApproverSpec): Approver {
  return spec.type === "llm_approver"
    ? new LlmApprover(spec)
    : new RuleBasedApprover(spec);
}

/** Build a name→approver map from specs (e.g. a compiled policy's `approvers`). */
export function approverMap(specs: ApproverSpec[] = []): Map<string, Approver> {
  return new Map(specs.map((s) => [s.name, makeApprover(s)]));
}

export interface ChainStep {
  approver: string;
  decision: Decision;
  rationale?: string;
}

export interface Resolution {
  final: Decision;
  chain: ChainStep[];
}

/**
 * Resolve a gate verdict to a final allow/deny. `allow`/`passthrough` pass through; anything that
 * isn't `approve` denies. An `approve` runs its named approvers as an AND-chain (first deny wins);
 * an approve with no approver, or one naming an unknown approver, denies closed.
 */
export async function resolveVerdict(
  result: VerdictResult,
  facts: ActionFacts,
  approvers: Map<string, Approver>,
): Promise<Resolution> {
  if (result.verdict === "allow" || result.verdict === "passthrough") {
    return { final: "allow", chain: [] };
  }
  if (result.verdict !== "approve") {
    return { final: "deny", chain: [] };
  }

  const names = result.approvers ?? [];
  if (names.length === 0) {
    return { final: "deny", chain: [] }; // approve with nobody to ask — deny-closed
  }

  const chain: ChainStep[] = [];
  for (const name of names) {
    const approver = approvers.get(name);
    if (!approver) {
      chain.push({ approver: name, decision: "deny", rationale: "unknown approver" });
      return { final: "deny", chain };
    }
    const d = await approver.review(facts);
    chain.push({ approver: name, decision: d.decision, rationale: d.rationale });
    if (d.decision === "deny") return { final: "deny", chain }; // short-circuit
  }
  return { final: "allow", chain };
}
