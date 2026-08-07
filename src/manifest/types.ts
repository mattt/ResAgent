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
  approver?: string;
  denyDefault: boolean;
  allow: AllowRule[];
}

export interface AllowRule {
  protocol: string;
  hosts: string[];
}

export interface ServeRule {
  /** namespace pattern, e.g. "research/*". */
  pattern: string;
  tailnetUsers: string[];
  funnel: boolean;
}
