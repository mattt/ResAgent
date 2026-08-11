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
 * `approve` blocks lower to `approve` verdict rules at priority -50 — between allow (0) and deny
 * (-100) — carrying the gate's `approver`, which the resolver ({@link "./approver.ts"}) runs above
 * the gate. `ReferenceGate` still emits the static `approve` verdict Claw Patrol fixtures compare.
 * Cross-references (an `approver`/`credential` a gate names must exist) are checked here and thrown.
 */

import type {
  ApproverSpec,
  CompiledRule,
  Credential,
  Endpoint,
  Policy,
} from "./policy.ts";
import type { Manifest } from "../manifest/types.ts";

/** Make a name safe for Claw Patrol's flat, globally-unique namespace. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Reject a gate that names an approver or credential no top-level block defines. */
function checkReferences(manifest: Manifest): void {
  const approverNames = new Set(manifest.approvers.map((a) => a.name));
  const credentialNames = new Set(manifest.credentials.map((c) => c.name));
  for (const gate of manifest.gates) {
    if (gate.approver && !approverNames.has(gate.approver)) {
      throw new Error(
        `gate "${gate.target}": unknown approver "${gate.approver}" (no matching approver block)`,
      );
    }
    for (const allow of gate.allow) {
      if (allow.credential && !credentialNames.has(allow.credential)) {
        throw new Error(
          `gate "${gate.target}": unknown credential "${allow.credential}" (no matching credential block)`,
        );
      }
    }
    if (gate.approve.length > 0 && !gate.approver) {
      throw new Error(
        `gate "${gate.target}": has approve rules but no approver to resolve them`,
      );
    }
  }
}

export function compileGates(manifest: Manifest): Policy {
  checkReferences(manifest);

  const endpoints: Endpoint[] = [];
  const rules: CompiledRule[] = [];
  const credentials: Credential[] = manifest.credentials.map((c) => ({ ...c }));
  const approvers: ApproverSpec[] = manifest.approvers.map((a) => ({ ...a }));

  for (const gate of manifest.gates) {
    const base = slug(gate.target);

    // Egress (`https`) and automation allows are named in independent groups so adding an automation
    // block never renames the https endpoints (keeps the compiled endpoint names stable).
    const httpsAllows = gate.allow.filter((a) => a.protocol !== "automation");
    const autoAllows = gate.allow.filter((a) => a.protocol === "automation");

    const pushDeny = (epName: string) => {
      if (gate.denyDefault) {
        rules.push({
          name: `${epName}-deny`,
          endpoint: epName,
          priority: -100,
          verdict: "deny",
          reason: `default deny for ${gate.target}`,
        });
      }
    };

    httpsAllows.forEach((allow, i) => {
      const epName = httpsAllows.length > 1 ? `${base}-${i}` : base;
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
      pushDeny(epName);
    });

    // `allow "automation"` → an automation endpoint whose "hosts" are the automation convention
    // strings, so the reference gate's host matching adjudicates it like any other endpoint (M9).
    autoAllows.forEach((allow, i) => {
      const epName = autoAllows.length > 1
        ? `${base}-automation-${i}`
        : `${base}-automation`;
      const hosts = [
        ...(allow.shortcuts ?? []).map((s) => `automation:shortcuts:${s}`),
        ...(allow.scripts ? ["automation:osascript"] : []),
      ];
      endpoints.push({ name: epName, type: "automation", hosts });
      rules.push({
        name: `${epName}-allow`,
        endpoint: epName,
        priority: 0,
        condition: allow.condition,
        verdict: "allow",
        reason: `allow automation (${hosts.join(", ") || "none"})`,
      });
      pushDeny(epName);
    });

    // Escalation rules sit between allow (0) and the default deny (-100): a matching request that
    // isn't a plain allow becomes `approve`, resolved through the gate's approver above the gate.
    gate.approve.forEach((appr, i) => {
      const epName = gate.approve.length > 1 ? `${base}-approve-${i}` : `${base}-approve`;
      endpoints.push({ name: epName, type: "https", hosts: appr.hosts });
      rules.push({
        name: `${epName}`,
        endpoint: epName,
        priority: -50,
        condition: appr.condition,
        approvers: gate.approver ? [gate.approver] : undefined,
        verdict: "approve",
        reason: `escalate ${appr.protocol} to ${
          appr.hosts.join(", ")
        } → approver ${gate.approver}`,
      });
    });
  }

  return { endpoints, credentials, rules, approvers };
}
