/**
 * The gate conformance corpus (M6) — the gate analog of `src/conformance/cases.ts`. A canonical
 * {@link Policy} plus request cases with their expected verdict. The reference gate must match
 * `expect` (self-check); real Claw Patrol must match the reference gate's full output (equivalence),
 * checked by `clawpatrol test`. Every case targets a claimed host, because `clawpatrol test` refuses
 * to replay an action for a host no endpoint claims (unknown-host denial is a runtime
 * `defaults.unknown_host` concern, asserted against the reference gate directly).
 */

import type { ActionFacts } from "./facts.ts";
import type { Policy, Verdict } from "./policy.ts";

export interface GateCase {
  name: string;
  facts: ActionFacts;
  /** Expected verdict — the reference gate is checked against this. */
  expect: Verdict;
  /** Reference-gate only: the Claw Patrol oracle can't replay it (e.g. Mac automation). */
  referenceOnly?: boolean;
}

export interface Corpus {
  policy: Policy;
  cases: GateCase[];
}

const policy: Policy = {
  endpoints: [
    { name: "hub", type: "https", hosts: ["huggingface.co", "*.hf.co"] },
    { name: "api", type: "https", hosts: ["api.example.com"] },
    // A Mac automation endpoint (M9): its "hosts" are the automation convention strings.
    {
      name: "auto",
      type: "automation",
      hosts: ["automation:shortcuts:Daily Digest", "automation:osascript"],
    },
  ],
  credentials: [{
    name: "hf",
    type: "header_token",
    header: "Authorization",
    prefix: "Bearer ",
    placeholder: "RESAGENT_HF_TOKEN",
    keychain: "resagent.gate.hf",
  }],
  // A deterministic judge (M7): a Hub write under /api/ escalates and is approved; anything else it
  // sees is denied. Rule-based so `gate:reference` resolves the chain CI-green.
  approvers: [{
    name: "judge",
    type: "rule_based",
    allowWhen: 'http.path.startsWith("/api/")',
  }],
  rules: [
    // Hub: read-only, token injected.
    {
      name: "hub-allow",
      endpoint: "hub",
      priority: 0,
      condition: 'http.method == "GET"',
      credential: "hf",
      verdict: "allow",
      reason: "read-only Hub",
    },
    // A Hub write escalates to the judge instead of a hard deny (M7).
    {
      name: "hub-approve",
      endpoint: "hub",
      priority: -50,
      condition: 'http.method == "POST"',
      approvers: ["judge"],
      verdict: "approve",
      reason: "escalate Hub write to the judge",
    },
    {
      name: "hub-deny",
      endpoint: "hub",
      priority: -100,
      verdict: "deny",
      reason: "hub default deny",
    },
    // API: only GET under /v1/.
    {
      name: "api-allow",
      endpoint: "api",
      priority: 0,
      condition: 'http.method == "GET" && http.path.startsWith("/v1/")',
      verdict: "allow",
      reason: "read-only v1 API",
    },
    {
      name: "api-deny",
      endpoint: "api",
      priority: -100,
      verdict: "deny",
      reason: "api default deny",
    },
    // Automation: only the listed shortcut and osascript are allowed (M9).
    {
      name: "auto-allow",
      endpoint: "auto",
      priority: 0,
      verdict: "allow",
      reason: "allowed automation",
    },
    {
      name: "auto-deny",
      endpoint: "auto",
      priority: -100,
      verdict: "deny",
      reason: "automation default deny",
    },
  ],
};

const http = (host: string, method: string, path: string): ActionFacts => ({
  host,
  http: { method, path },
});

export const corpus: Corpus = {
  policy,
  cases: [
    {
      name: "hub GET is allowed",
      facts: http("huggingface.co", "GET", "/api/models"),
      expect: "allow",
    },
    {
      name: "hub POST escalates to the approver",
      facts: http("huggingface.co", "POST", "/api/models"),
      expect: "approve",
    },
    {
      name: "hub wildcard host is allowed",
      facts: http("cdn.hf.co", "GET", "/x"),
      expect: "allow",
    },
    {
      name: "api GET /v1 is allowed",
      facts: http("api.example.com", "GET", "/v1/models"),
      expect: "allow",
    },
    {
      name: "api GET /admin is denied",
      facts: http("api.example.com", "GET", "/admin"),
      expect: "deny",
    },
    {
      name: "api DELETE /v1 is denied",
      facts: http("api.example.com", "DELETE", "/v1/x"),
      expect: "deny",
    },
    // Automation (M9) — reference-gate only; Claw Patrol doesn't model Mac automation.
    {
      name: "a listed shortcut is allowed",
      facts: {
        host: "automation:shortcuts:Daily Digest",
        automation: { kind: "shortcuts", name: "Daily Digest" },
      },
      expect: "allow",
      referenceOnly: true,
    },
    {
      name: "an unlisted shortcut is denied",
      facts: {
        host: "automation:shortcuts:Wipe Disk",
        automation: { kind: "shortcuts", name: "Wipe Disk" },
      },
      expect: "deny",
      referenceOnly: true,
    },
    {
      name: "an allowed osascript runs",
      facts: {
        host: "automation:osascript",
        automation: { kind: "osascript", input: "1+1" },
      },
      expect: "allow",
      referenceOnly: true,
    },
  ],
};
