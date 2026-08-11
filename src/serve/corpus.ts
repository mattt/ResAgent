/**
 * The tailnet-identity corpus (M8) — the serve analog of the gate corpus. A canonical set of `serve`
 * rules plus request cases (target + identity) with the expected allow/deny. `evaluateIdentity` is
 * checked against `expect`; a live tailnet leg (Tailscale serve end to end) would be measured against
 * the same cases once a tailnet is available.
 */

import type { ServeRule } from "../manifest/types.ts";
import type { Identity } from "./identity.ts";

export interface ServeCase {
  name: string;
  target: string;
  identity: Identity | null;
  expect: boolean;
}

export interface ServeCorpus {
  serves: ServeRule[];
  cases: ServeCase[];
}

const serves: ServeRule[] = [
  { pattern: "research/*", tailnetUsers: ["mattt@"], funnel: false },
  {
    pattern: "family/ChoreBoard",
    tailnetUsers: ["mattt@example.com", "kid@example.com"],
    funnel: false,
  },
  // A funnel-exposed route (public internet) — still identity-gated to one user.
  { pattern: "public/*", tailnetUsers: ["mattt@"], funnel: true },
];

const login = (l: string): Identity => ({ login: l });

export const corpus: ServeCorpus = {
  serves,
  cases: [
    {
      name: "user@ local-part form allows any login with that local part",
      target: "research/ResearchAgent",
      identity: login("mattt@example.com"),
      expect: true,
    },
    {
      name: "a wildcard pattern matches another object in the namespace",
      target: "research/TriageAgent",
      identity: login("mattt@corp.ts.net"),
      expect: true,
    },
    {
      name: "an exact login matches",
      target: "family/ChoreBoard",
      identity: login("kid@example.com"),
      expect: true,
    },
    {
      name: "a user not in tailnet_users is denied",
      target: "family/ChoreBoard",
      identity: login("stranger@example.com"),
      expect: false,
    },
    {
      name: "a target no serve rule matches is denied",
      target: "secrets/Vault",
      identity: login("mattt@example.com"),
      expect: false,
    },
    {
      name: "a request with no identity is denied",
      target: "research/ResearchAgent",
      identity: null,
      expect: false,
    },
    {
      name: "a funnel-exposed route is still identity-gated",
      target: "public/Status",
      identity: login("mattt@example.com"),
      expect: true,
    },
  ],
};
