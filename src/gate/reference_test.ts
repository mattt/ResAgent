import { assert, assertEquals } from "jsr:@std/assert@^1";
import { ReferenceGate } from "./reference.ts";
import type { Policy } from "./policy.ts";

const policy: Policy = {
  endpoints: [{ name: "hf", type: "https", hosts: ["huggingface.co", "*.hf.co"] }],
  credentials: [{
    name: "hf",
    type: "header_token",
    header: "Authorization",
    prefix: "Bearer ",
    placeholder: "RESAGENT_HF_TOKEN",
    keychain: "resagent.gate.hf",
  }],
  rules: [
    {
      name: "hf-allow",
      endpoint: "hf",
      priority: 0,
      condition: 'http.method == "GET"',
      credential: "hf",
      verdict: "allow",
      reason: "read-only Hub",
    },
    { name: "hf-deny", endpoint: "hf", priority: -100, verdict: "deny", reason: "default deny" },
  ],
};

async function gate(): Promise<ReferenceGate> {
  const g = new ReferenceGate();
  await g.applyPolicy(policy);
  return g;
}

Deno.test("reference: allowed host + condition → allow, injects the credential", async () => {
  const g = await gate();
  const r = await g.evaluate({ host: "huggingface.co", http: { method: "GET", path: "/api" } });
  assertEquals(r.verdict, "allow");
  assertEquals(r.rule, "hf-allow");
  assertEquals(r.endpoint, "https.hf");
  assertEquals(r.credential, "hf");
});

Deno.test("reference: allowed host but condition fails → per-endpoint catch-all deny", async () => {
  const g = await gate();
  const r = await g.evaluate({ host: "huggingface.co", http: { method: "POST", path: "/api" } });
  assertEquals(r.verdict, "deny");
  assertEquals(r.rule, "hf-deny");
  assertEquals(r.credential, undefined);
});

Deno.test("reference: disallowed host → no rule matches, deny-closed", async () => {
  const g = await gate();
  const r = await g.evaluate({ host: "evil.example.com", http: { method: "GET", path: "/" } });
  assertEquals(r.verdict, "deny");
  assert(r.reason?.includes("no matching rule"));
});

Deno.test("reference: host glob matches a subdomain", async () => {
  const g = await gate();
  const r = await g.evaluate({ host: "cdn.hf.co", http: { method: "GET", path: "/" } });
  assertEquals(r.verdict, "allow");
  assertEquals(r.endpoint, "https.hf");
});

Deno.test("reference: higher priority rule wins over a lower one", async () => {
  const g = new ReferenceGate();
  await g.applyPolicy({
    endpoints: [{ name: "ep", type: "https", hosts: ["api.example.com"] }],
    credentials: [],
    rules: [
      { name: "low-allow", endpoint: "ep", priority: 0, verdict: "allow", reason: "allow" },
      { name: "high-deny", endpoint: "ep", priority: 10, verdict: "deny", reason: "block" },
    ],
  });
  const r = await g.evaluate({ host: "api.example.com", http: { method: "GET", path: "/" } });
  assertEquals(r.verdict, "deny");
  assertEquals(r.rule, "high-deny");
});

Deno.test("reference: empty policy denies closed", async () => {
  const g = new ReferenceGate();
  await g.applyPolicy({ endpoints: [], credentials: [], rules: [] });
  const r = await g.evaluate({ host: "anything", http: { method: "GET", path: "/" } });
  assertEquals(r.verdict, "deny");
  assert(r.reason?.includes("no matching rule"));
});
