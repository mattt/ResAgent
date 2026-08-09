/**
 * Compile a gate {@link Policy} into the inspector's typed gate-rule rows (M6, the C5 read side).
 * This is the composition seam between the gate layer and the C5 protocol: the shell seeds the
 * daemon's `gate.rules` view with these, so the inspector renders egress rules in the same ResEdit
 * idiom as storage and alarms, read through the one protocol that works against either engine.
 */

import { endpointOf, endpointRef, type Policy } from "./policy.ts";
import type { GateRuleInfo } from "../protocol/messages.ts";

export function policyToGateRules(policy: Policy): GateRuleInfo[] {
  return policy.rules.map((rule) => {
    const ep = rule.endpoint ? endpointOf(policy, rule.endpoint) : undefined;
    const info: GateRuleInfo = {
      name: rule.name,
      hosts: ep?.hosts ?? [],
      verdict: rule.verdict,
      priority: rule.priority,
    };
    if (ep) info.endpoint = endpointRef(ep);
    if (rule.condition) info.condition = rule.condition;
    if (rule.credential) info.credential = rule.credential;
    if (rule.reason) info.reason = rule.reason;
    return info;
  });
}
