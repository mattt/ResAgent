/**
 * The ResAgent manifest model (contract C4).
 *
 * A single HCL grammar declares the deployment AND the gate/identity policy. This is the typed,
 * engine-neutral shape the control plane works with; `parse.ts` builds it from HCL and
 * `wrangler.ts` lowers the deploy-relevant parts to a `wrangler.toml` for `celld deploy`.
 */

export interface Manifest {
  namespaces: Namespace[];
  /** Egress gate rules (Claw Patrol) — not part of the deploy. */
  gates: GateRule[];
  /** Wire credentials injected by the gate from Keychain — not part of the deploy. */
  credentials: Credential[];
  /** Verdict-chain approvers referenced by gates (on-device judge / rule-based) — M7. */
  approvers: Approver[];
  /** Tailnet serve/identity rules (Tailscale) — not part of the deploy. */
  serves: ServeRule[];
}

export interface Namespace {
  name: string;
  objects: DurableObjectDecl[];
}

export interface DurableObjectDecl {
  /** Binding name / label, e.g. "ResearchAgent". */
  name: string;
  /** Module that exports the class. */
  entrypoint: string;
  /** Exported class name (defaults to `name`). */
  className: string;
  /** Plain string env, lowered to `[vars]`. */
  env: Record<string, string>;
  /** env.AI bindings — ResAgent-level, injected at runtime (not in wrangler.toml). */
  ai: AiBinding[];
  /** Granted-folder bindings — ResAgent-level (security-scoped bookmarks), not in wrangler.toml. */
  folders: FolderBinding[];
}

export interface AiBinding {
  name: string;
  endpoint: string;
}

export interface FolderBinding {
  name: string;
  grant: string;
  mode: string;
}

export interface GateRule {
  /** namespace/object this rule governs, e.g. "research/ResearchAgent". */
  target: string;
  /** Name of a top-level {@link Approver} that `approve` escalations resolve through (M7). */
  approver?: string;
  denyDefault: boolean;
  allow: AllowRule[];
  /** Escalation rules: matching requests get an `approve` verdict resolved by `approver` (M7). */
  approve: ApproveRule[];
}

export interface AllowRule {
  /** Block label: `https` for egress, `automation` for Mac automation (M9). */
  protocol: string;
  hosts: string[];
  /** Optional CEL-subset condition, e.g. `http.method == "GET"`. Absent = match any request. */
  condition?: string;
  /** Name of a top-level {@link Credential} the gate injects at the wire for matching requests. */
  credential?: string;
  /** `allow "automation"`: named Shortcuts the object may run (M9). */
  shortcuts?: string[];
  /** `allow "automation"`: whether the object may run osascript (M9). */
  scripts?: boolean;
}

/**
 * An escalation rule: requests to these hosts (optionally narrowed by `condition`) get an `approve`
 * verdict instead of a hard deny, resolved through the gate's {@link Approver} (M7).
 */
export interface ApproveRule {
  protocol: string;
  hosts: string[];
  condition?: string;
}

/**
 * A verdict-chain approver (M7). `rule_based` decides from a CEL `allowWhen`; `llm_approver` asks an
 * on-device OpenAI-compatible model (contract C3). The gate stays allow/deny/approve; resolving an
 * `approve` to allow/deny happens above the gate.
 */
export interface Approver {
  name: string;
  type: "llm_approver" | "rule_based";
  model?: string;
  endpoint?: string;
  prompt?: string;
  allowWhen?: string;
}

/**
 * A wire credential the gate holds and injects, so the object never carries the secret. The real
 * value is read from the macOS Keychain (`keychain`) at policy-apply time; the object sends
 * `placeholder`, and the gate swaps in the secret. Types mirror Claw Patrol's credential kinds.
 */
export interface Credential {
  name: string;
  type: "bearer_token" | "header_token" | "basic_auth";
  /** Header name for `header_token` (e.g. "Authorization"). */
  header?: string;
  /** Value prefix for `header_token` (e.g. "Bearer "). */
  prefix?: string;
  /** Username for `basic_auth`. */
  username?: string;
  /** Placeholder the object sends in place of the real secret. */
  placeholder: string;
  /** macOS Keychain service the real secret is read from (e.g. "resagent.gate.hf"). */
  keychain: string;
}

export interface ServeRule {
  /** namespace pattern, e.g. "research/*". */
  pattern: string;
  tailnetUsers: string[];
  funnel: boolean;
}
