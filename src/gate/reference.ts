/**
 * The in-process reference gate.
 *
 * Implements the gate's verdict semantics directly — sort rules by priority (ties keep compiled
 * order), first rule whose endpoint host-matches and whose condition holds wins; a global rule
 * (no endpoint) matches any host. It is the develop-against substrate — no subprocess, no Claw
 * Patrol, runnable in CI with no permissions — and it defines what "correct" means for the corpus.
 * It is NOT the oracle for judging Claw Patrol; that is `clawpatrol test` (see {@link
 * "./clawpatrol.ts"}). The two must agree on every corpus case.
 */

import type { ActionFacts } from "./facts.ts";
import type { GateController, VerdictResult } from "./controller.ts";
import {
  type CompiledRule,
  type Endpoint,
  endpointOf,
  endpointRef,
  hostMatches,
  type Policy,
} from "./policy.ts";
import { evaluateCondition } from "./cel.ts";

export class ReferenceGate implements GateController {
  readonly name = "reference";
  #policy: Policy = { endpoints: [], credentials: [], rules: [] };

  applyPolicy(policy: Policy): Promise<void> {
    this.#policy = policy;
    return Promise.resolve();
  }

  evaluate(facts: ActionFacts): Promise<VerdictResult> {
    // Stable sort by descending priority: decorate with index, compare priority then index.
    const ordered = this.#policy.rules
      .map((rule, i) => ({ rule, i }))
      .sort((a, b) => (b.rule.priority - a.rule.priority) || (a.i - b.i))
      .map((x) => x.rule);

    for (const rule of ordered) {
      const ep = this.#matchEndpoint(rule, facts.host);
      if (ep === "no-match") continue;
      if (rule.condition && !evaluateCondition(rule.condition, facts)) continue;
      const result: VerdictResult = {
        verdict: rule.verdict,
        rule: rule.name,
        reason: rule.reason,
      };
      if (ep) result.endpoint = endpointRef(ep);
      if (rule.verdict === "allow" && rule.credential) {
        result.credential = rule.credential;
      }
      if (rule.verdict === "approve" && rule.approvers?.length) {
        result.approvers = rule.approvers;
      }
      return Promise.resolve(result);
    }

    // No rule matched (a policy without a default rule). Deny closed.
    return Promise.resolve({ verdict: "deny", reason: "no matching rule" });
  }

  /**
   * Resolve which endpoint a rule matches for `host`:
   *  - `"no-match"`: rule targets an endpoint whose hosts don't include `host` → skip the rule.
   *  - `undefined`:  global rule (no endpoint) → matches any host, no typed ref.
   *  - `Endpoint`:   the matched endpoint.
   */
  #matchEndpoint(rule: CompiledRule, host: string): Endpoint | undefined | "no-match" {
    if (!rule.endpoint) return undefined;
    const ep = endpointOf(this.#policy, rule.endpoint);
    if (!ep) return "no-match";
    return hostMatches(ep.hosts, host) ? ep : "no-match";
  }
}
