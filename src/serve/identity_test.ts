/**
 * Tailnet identity evaluation (M8): the corpus passes, header parsing reads the Tailscale identity
 * headers, and the deny-closed edges hold. CI-safe (pure, synthetic headers).
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { evaluateIdentity, identityFromHeaders } from "./identity.ts";
import { corpus } from "./corpus.ts";

Deno.test("identity: the serve corpus evaluates as expected", () => {
  for (const c of corpus.cases) {
    const d = evaluateIdentity(corpus.serves, c.target, c.identity);
    assertEquals(d.allowed, c.expect, `${c.name}: ${d.reason}`);
  }
});

Deno.test("identity: headers parse into a login/name/node identity", () => {
  const id = identityFromHeaders({
    "Tailscale-User-Login": "mattt@example.com",
    "Tailscale-User-Name": "Mattt",
    "Tailscale-Node-Name": "laptop",
  });
  assertEquals(id, { login: "mattt@example.com", name: "Mattt", node: "laptop" });

  // Case-insensitive, and a Headers object works too.
  const fromHeaders = identityFromHeaders(
    new Headers({ "tailscale-user-login": "kid@example.com" }),
  );
  assertEquals(fromHeaders?.login, "kid@example.com");

  // No tailnet headers ⇒ null (an identity-less request, handled by allowLocal at the ingress).
  assertEquals(identityFromHeaders({ "x-other": "1" }), null);
});

Deno.test("identity: the matched rule and funnel flag are reported", () => {
  const allowed = evaluateIdentity(corpus.serves, "public/Status", {
    login: "mattt@example.com",
  });
  assert(allowed.allowed);
  assertEquals(allowed.funnel, true);
  assertEquals(allowed.rule?.pattern, "public/*");

  const denied = evaluateIdentity(corpus.serves, "research/ResearchAgent", {
    login: "eve@example.com",
  });
  assert(!denied.allowed);
  assert(denied.reason.includes("not in tailnet_users"));
});
