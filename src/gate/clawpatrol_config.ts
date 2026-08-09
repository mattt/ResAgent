/**
 * Lower a neutral {@link Policy} to Claw Patrol's native `config.hcl` (M6, the translate-down half of
 * C4 — the gate analog of `src/manifest/wrangler.ts`). The emitted config is fed to `clawpatrol
 * validate` (structure oracle) and `clawpatrol test` (verdict oracle), and drives a live gateway.
 *
 * Mapping choices that keep our reference verdicts aligned with Claw Patrol's:
 *  - each {@link Endpoint} → `endpoint "https" "<name>" { hosts = [...] }`;
 *  - each {@link CompiledRule} → `rule "<name>" { endpoint = https.<name>; condition; verdict;
 *    reason }` — a rule carries NO `credential` predicate, so verdicts depend only on endpoint +
 *    condition, exactly as the reference gate computes them;
 *  - injection is configured on the credential block instead: a credential is bound (via `endpoint`)
 *    to the endpoints whose allow rules reference it, so the gateway swaps the placeholder for the
 *    real secret on allowed traffic. Secret VALUES are never written here — they load from Keychain.
 *
 * References are Claw Patrol's `<endpoint-type>.<name>` traversals (`https.hf`), verified against
 * `clawpatrol validate` 0.5.8. A `defaults { unknown_host }` knob makes traffic to hosts no endpoint
 * claims deterministic (we default it to `deny`, matching our deny-closed reference gate).
 */

import { endpointRef, type Policy } from "./policy.ts";

export interface ConfigOptions {
  stateDir?: string;
  dashboardListen?: string;
  publicUrl?: string;
  /** A WireGuard transport, required to `validate` or run a live gateway (not for verdict replay). */
  wireguard?: { subnetCidr: string; endpoint?: string };
  /** What Claw Patrol does with traffic to a host no endpoint claims. Default `deny` (deny-closed). */
  unknownHost?: "deny" | "allow" | "passthrough";
  /** Emit credential blocks (they bind injection). Off for pure verdict replay, which ignores them. */
  includeCredentials?: boolean;
}

const q = (s: string): string => JSON.stringify(s);
const arr = (a: string[]): string => `[${a.map(q).join(", ")}]`;

export function toClawPatrolConfig(policy: Policy, opts: ConfigOptions = {}): string {
  const refOf = (name: string): string => {
    const ep = policy.endpoints.find((e) => e.name === name);
    return ep ? endpointRef(ep) : name;
  };

  const out: string[] = ["schema_version = 1", ""];

  const gw: string[] = [];
  if (opts.dashboardListen) gw.push(`  dashboard_listen = ${q(opts.dashboardListen)}`);
  if (opts.publicUrl) gw.push(`  public_url = ${q(opts.publicUrl)}`);
  if (opts.stateDir) gw.push(`  state_dir = ${q(opts.stateDir)}`);
  if (opts.wireguard) {
    gw.push("  wireguard {");
    gw.push(`    subnet_cidr = ${q(opts.wireguard.subnetCidr)}`);
    if (opts.wireguard.endpoint) {
      gw.push(`    endpoint    = ${q(opts.wireguard.endpoint)}`);
    }
    gw.push("  }");
  }
  out.push("gateway {", ...gw, "}", "");

  if (opts.unknownHost) {
    out.push("defaults {", `  unknown_host = ${q(opts.unknownHost)}`, "}", "");
  }

  for (const ep of policy.endpoints) {
    out.push(`endpoint "https" ${q(ep.name)} {`, `  hosts = ${arr(ep.hosts)}`, "}", "");
  }

  if (opts.includeCredentials !== false) {
    for (const cred of policy.credentials) {
      const bound = [
        ...new Set(
          policy.rules.filter((r) => r.credential === cred.name && r.endpoint).map((r) =>
            r.endpoint!
          ),
        ),
      ];
      const body: string[] = [];
      if (cred.header) body.push(`  header = ${q(cred.header)}`);
      if (cred.prefix) body.push(`  prefix = ${q(cred.prefix)}`);
      if (cred.username) body.push(`  username = ${q(cred.username)}`);
      if (bound.length === 1) body.push(`  endpoint = ${refOf(bound[0])}`);
      else if (bound.length > 1) {
        body.push(`  endpoints = [${bound.map(refOf).join(", ")}]`);
      }
      out.push(`credential ${q(cred.type)} ${q(cred.name)} {`, ...body, "}", "");
    }
  }

  for (const rule of policy.rules) {
    const body: string[] = [];
    if (rule.endpoint) body.push(`  endpoint = ${refOf(rule.endpoint)}`);
    if (rule.priority !== 0) body.push(`  priority = ${rule.priority}`);
    if (rule.condition) body.push(`  condition = ${q(rule.condition)}`);
    body.push(`  verdict = ${q(rule.verdict)}`);
    if (rule.reason) body.push(`  reason = ${q(rule.reason)}`);
    out.push(`rule ${q(rule.name)} {`, ...body, "}", "");
  }

  return out.join("\n").replace(/\n+$/, "\n");
}
