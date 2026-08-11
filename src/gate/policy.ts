/**
 * The compiled, engine-neutral gate policy (M6).
 *
 * This is the shape both gate backends work against — the in-process {@link
 * "./reference.ts".ReferenceGate} and the real {@link "./clawpatrol.ts".ClawPatrolGate}. It is
 * lowered from the C4 manifest by {@link "./compile.ts".compileGates} and lowered *further* to Claw
 * Patrol's native config by {@link "./clawpatrol_config.ts".toClawPatrolConfig}. No manifest types
 * and no Claw Patrol types leak in — this is the neutral middle, exactly as `Engine` (C2) and
 * `DaemonBackend` (C5) are neutral middles for their layers.
 */

/** A gate decision. Mirrors Claw Patrol's verdict vocabulary so fixtures compare directly. */
export type Verdict = "allow" | "deny" | "approve" | "passthrough";

/**
 * A typed target: a host allow-list. `https` is an egress endpoint (M6); `automation` is a Mac
 * automation endpoint (M9) whose "hosts" are the automation convention strings
 * (`automation:shortcuts:<name>` / `automation:osascript`), so host matching is reused verbatim.
 */
export interface Endpoint {
  name: string;
  type: "https" | "automation";
  /** Host globs (only `*` wildcard), e.g. `["huggingface.co", "*.hf.co"]`. */
  hosts: string[];
}

/**
 * A wire credential the gate injects so the object never carries the secret. The real value is read
 * from the macOS Keychain (`keychain`); the object sends `placeholder`.
 */
export interface Credential {
  name: string;
  type: "bearer_token" | "header_token" | "basic_auth";
  header?: string;
  prefix?: string;
  username?: string;
  placeholder: string;
  keychain: string;
}

/**
 * A verdict-chain approver the gate escalates an `approve` verdict to (M7). `rule_based` decides
 * deterministically from a CEL `allowWhen`; `llm_approver` asks an on-device OpenAI-compatible model
 * (contract C3). Static gate verdicts stay allow/deny/approve; resolving an `approve` to a final
 * allow/deny is a layer above the gate ({@link "./approver.ts".resolveVerdict}).
 */
export interface ApproverSpec {
  name: string;
  type: "llm_approver" | "rule_based";
  /** Model id for `llm_approver` (contract C3). */
  model?: string;
  /** OpenAI-compatible endpoint for `llm_approver`, e.g. `http://127.0.0.1:8788`. */
  endpoint?: string;
  /** System prompt for `llm_approver`. */
  prompt?: string;
  /** CEL-subset condition for `rule_based`; holds ⇒ allow, else deny. */
  allowWhen?: string;
}

/**
 * One policy decision. Higher `priority` runs first; ties keep compiled order. `endpoint` names the
 * target whose hosts must match (absent = matches any host — a global rule, e.g. default-deny).
 * `condition` is a CEL-subset expression ({@link "./cel.ts"}); absent = matches any request.
 * `credential` is injected only when the rule fires with an `allow` verdict. `approvers` names the
 * verdict-chain approvers an `approve` verdict escalates to (AND-chain, deny-closed — M7).
 */
export interface CompiledRule {
  name: string;
  endpoint?: string;
  priority: number;
  condition?: string;
  credential?: string;
  approvers?: string[];
  verdict: Verdict;
  reason: string;
}

export interface Policy {
  endpoints: Endpoint[];
  credentials: Credential[];
  rules: CompiledRule[];
  /** Verdict-chain approvers referenced by `approve` rules (M7). Optional; absent = none. */
  approvers?: ApproverSpec[];
}

/** Look up an endpoint by name. */
export function endpointOf(policy: Policy, name: string): Endpoint | undefined {
  return policy.endpoints.find((e) => e.name === name);
}

/** The typed reference Claw Patrol reports for a matched endpoint, e.g. `https.hf`. */
export function endpointRef(e: Endpoint): string {
  return `${e.type}.${e.name}`;
}

/** Does `host` match any of the endpoint's host globs? Only `*` is a wildcard. */
export function hostMatches(hosts: string[], host: string): boolean {
  return hosts.some((glob) => globToRegExp(glob).test(host));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
  return new RegExp(`^${escaped}$`, "i");
}
