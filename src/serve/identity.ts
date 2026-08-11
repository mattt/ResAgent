/**
 * Tailnet identity evaluation (M8) — pure and engine-neutral.
 *
 * When an object is exposed over `tailscale serve`, Tailscale terminates the tailnet connection at a
 * loopback proxy and stamps the caller's verified identity into request headers
 * (`Tailscale-User-Login`, `-User-Name`, `Tailscale-Node-Name`). This module reads those headers and
 * decides, from the manifest's `serve` rules, whether a given tailnet user may reach a given object.
 * It is the identity analog of the egress gate: a small, deny-closed policy evaluator with a corpus.
 *
 * Header-trust note: identity headers are only trustworthy when they come from the local serve proxy
 * (loopback). A plain local request carries no identity and must NOT be treated as an authenticated
 * user — the {@link "./ingress.ts"} layer only forwards an identity-less request when `allowLocal` is
 * set (localhost stays first-class); everything from the tailnet arrives with identity.
 */

import type { ServeRule } from "../manifest/types.ts";

export interface Identity {
  /** Tailscale-User-Login, e.g. `mattt@example.com`. */
  login?: string;
  /** Tailscale-User-Name (display name). */
  name?: string;
  /** Tailscale-Node-Name. */
  node?: string;
}

export interface IdentityDecision {
  allowed: boolean;
  reason: string;
  /** The serve rule that matched the target, if any. */
  rule?: ServeRule;
  /** Whether the matched rule is funnel-exposed (public internet). */
  funnel: boolean;
}

type HeaderLike = Headers | Record<string, string>;

function header(h: HeaderLike, name: string): string | undefined {
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Read a tailnet {@link Identity} from request headers, or null if no login header is present. */
export function identityFromHeaders(h: HeaderLike): Identity | null {
  const login = header(h, "Tailscale-User-Login");
  const name = header(h, "Tailscale-User-Name");
  const node = header(h, "Tailscale-Node-Name");
  if (!login && !node) return null; // no tailnet identity on this request
  return { login, name, node };
}

/**
 * Glob `namespace/object` patterns. `*` matches within one path segment (no `/`), so `research/*`
 * matches `research/ResearchAgent` but not `research/a/b`. Mirrors the gate's host glob, adapted from
 * dot-delimited hosts to slash-delimited targets.
 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function patternMatches(pattern: string, target: string): boolean {
  return patternToRegExp(pattern).test(target);
}

/**
 * Does `login` satisfy a `tailnet_users` entry? An entry is either a full login (`mattt@example.com`,
 * exact match) or the `user@` local-part form (`mattt@`, matches any login with that local part).
 */
function userMatches(login: string, entry: string): boolean {
  if (entry === login) return true;
  if (entry.endsWith("@")) return login.startsWith(entry);
  return false;
}

/**
 * Decide whether `identity` may reach `target` (a `namespace/object` string) under `serves`.
 * Deny-closed: no matching serve rule, no identity, or a user not in `tailnet_users` all deny.
 */
export function evaluateIdentity(
  serves: ServeRule[],
  target: string,
  identity: Identity | null,
): IdentityDecision {
  const rule = serves.find((s) => patternMatches(s.pattern, target));
  if (!rule) {
    return { allowed: false, reason: `no serve rule matches ${target}`, funnel: false };
  }
  if (!identity?.login) {
    return {
      allowed: false,
      reason: "no tailnet identity on the request",
      rule,
      funnel: rule.funnel,
    };
  }
  const ok = rule.tailnetUsers.some((u) => userMatches(identity.login!, u));
  return {
    allowed: ok,
    reason: ok
      ? `${identity.login} permitted by serve ${rule.pattern}`
      : `${identity.login} is not in tailnet_users for ${rule.pattern}`,
    rule,
    funnel: rule.funnel,
  };
}
