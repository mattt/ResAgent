/**
 * Lower the C4 manifest's gate blocks to a neutral {@link Policy} (M6). This is the one place the
 * manifest's shape (`gate`/`allow`/`credential`) meets the gate's shape; both backends and the
 * corpus consume the `Policy`, never the manifest. Each `gate` target becomes one `https` endpoint
 * per allow host-group + an allow rule (with the optional condition/credential).
 *
 * `deny_default` lowers in two aligned halves, because Claw Patrol has no global no-endpoint rule:
 *  - a per-endpoint catch-all deny (`priority -100`) so a claimed host that fails the allow
 *    condition is denied — matched identically by the reference gate;
 *  - traffic to a host no endpoint claims is denied by Claw Patrol's `defaults { unknown_host =
 *    "deny" }` (emitted by the config lowerer) and by the reference gate's deny-closed fallback
 *    (no rule matches → deny). Both ends agree on every case; the gate corpus proves it.
 *
 * `approver` is preserved in the manifest but intentionally not lowered: verdict chains with the
 * on-device judge are M7, so M6 emits allow/deny only.
 */

import type { Manifest } from "../manifest/types.ts";
import type { CompiledRule, Credential, Endpoint, Policy } from "./policy.ts";

/** Make a name safe for Claw Patrol's flat, globally-unique namespace. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function compileGates(manifest: Manifest): Policy {
  const endpoints: Endpoint[] = [];
  const rules: CompiledRule[] = [];
  const credentials: Credential[] = manifest.credentials.map((c) => ({ ...c }));

  for (const gate of manifest.gates) {
    const base = slug(gate.target);
    gate.allow.forEach((allow, i) => {
      const epName = gate.allow.length > 1 ? `${base}-${i}` : base;
      endpoints.push({ name: epName, type: "https", hosts: allow.hosts });
      rules.push({
        name: `${epName}-allow`,
        endpoint: epName,
        priority: 0,
        condition: allow.condition,
        credential: allow.credential,
        verdict: "allow",
        reason: `allow ${allow.protocol} to ${allow.hosts.join(", ")}`,
      });
      if (gate.denyDefault) {
        rules.push({
          name: `${epName}-deny`,
          endpoint: epName,
          priority: -100,
          verdict: "deny",
          reason: `default deny for ${gate.target}`,
        });
      }
    });
  }

  return { endpoints, credentials, rules };
}
