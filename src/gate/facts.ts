/**
 * Neutral action facts — one intercepted request, in the vocabulary Claw Patrol's `test` fixtures
 * use, so a fact set serializes straight to a fixture `action` (see {@link "./corpus.ts"}). Exactly
 * one protocol facet is set per action. The reference CEL evaluator ({@link "./cel.ts"}) reads facts
 * through this shape; the same fields are the CEL fact namespace (`http.method`, `k8s.resource`, …).
 */

export interface HttpFacet {
  method: string;
  path: string;
  query?: string;
  /** Header name → value(s). Lookups are case-insensitive. */
  headers?: Record<string, string | string[]>;
  /** Raw body; `http.body_json.<k>` is derived by JSON-parsing this. */
  body?: string;
}

export interface SqlFacet {
  statement: string;
  verb?: string;
  tables?: string[];
}

export interface K8sFacet {
  verb: string;
  resource: string;
  namespace?: string;
  name?: string;
}

export interface SshFacet {
  verb: string;
  command?: string;
}

export interface ActionFacts {
  /** The host the agent dialed, e.g. `huggingface.co`. */
  host: string;
  /** Credential identifier the object presented (usually a placeholder). */
  credential?: string;
  peer_ip?: string;
  http?: HttpFacet;
  sql?: SqlFacet;
  k8s?: K8sFacet;
  ssh?: SshFacet;
}
