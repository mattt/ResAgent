/**
 * The tailnet ingress (M8): an authenticated user is forwarded, a non-permitted user gets 403 and is
 * NOT forwarded, and an identity-less request is refused unless allowLocal. CI-safe (fake forward).
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { type IngressLogEntry, serveIngress } from "./ingress.ts";
import { corpus } from "./corpus.ts";

function ingress(allowLocal = false) {
  const log: IngressLogEntry[] = [];
  const forwarded: string[] = [];
  const handler = serveIngress({
    serves: corpus.serves,
    allowLocal,
    log: (e) => log.push(e),
    forward: (target) => {
      forwarded.push(target);
      return Promise.resolve(Response.json({ routed: target }));
    },
  });
  return { handler, log, forwarded };
}

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://ingress${path}`, { headers });

Deno.test("ingress: an authenticated tailnet user is routed to the object", async () => {
  const { handler, forwarded } = ingress();
  const res = await handler(
    req("/research/ResearchAgent/run", { "Tailscale-User-Login": "mattt@example.com" }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { routed: "research/ResearchAgent" });
  assertEquals(forwarded, ["research/ResearchAgent"]);
});

Deno.test("ingress: a non-permitted user gets 403 and is not forwarded", async () => {
  const { handler, forwarded } = ingress();
  const res = await handler(
    req("/family/ChoreBoard", { "Tailscale-User-Login": "stranger@example.com" }),
  );
  assertEquals(res.status, 403);
  assertEquals(forwarded, []);
});

Deno.test("ingress: an identity-less request is denied, but allowLocal forwards it", async () => {
  const denied = ingress(false);
  assertEquals((await denied.handler(req("/research/ResearchAgent"))).status, 403);
  assertEquals(denied.forwarded, []);

  const local = ingress(true);
  const res = await local.handler(req("/research/ResearchAgent"));
  assertEquals(res.status, 200);
  assertEquals(local.forwarded, ["research/ResearchAgent"]);
  assert(local.log.at(-1)?.reason.includes("allowLocal"));
});

Deno.test("ingress: a path without a namespace/object is a 404", async () => {
  const { handler } = ingress();
  assertEquals((await handler(req("/research"))).status, 404);
});
