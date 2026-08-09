import { assert, assertEquals } from "jsr:@std/assert@^1";
import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "./compile.ts";

const exampleUrl = new URL("../../examples/research-agent/resagent.hcl", import.meta.url);
const example = await Deno.readTextFile(exampleUrl);

Deno.test("compile: the example manifest lowers to a policy", async () => {
  const m = await parseManifest(example);
  const policy = compileGates(m);

  // One endpoint for the single allow host-group.
  assertEquals(policy.endpoints.length, 1);
  const ep = policy.endpoints[0];
  assertEquals(ep.type, "https");
  assert(ep.hosts.includes("huggingface.co"));
  assert(ep.hosts.includes("*.hf.co"));

  // An allow rule (with condition + credential) and a global default-deny.
  const allow = policy.rules.find((r) => r.verdict === "allow");
  assert(allow);
  assertEquals(allow!.endpoint, ep.name);
  assertEquals(allow!.condition, 'http.method == "GET"');
  assertEquals(allow!.credential, "hf");

  const deny = policy.rules.find((r) => r.verdict === "deny");
  assert(deny);
  assertEquals(deny!.endpoint, ep.name); // per-endpoint catch-all (Claw Patrol has no global rule)
  assertEquals(deny!.priority, -100);

  // The credential is carried through for injection.
  assertEquals(policy.credentials.length, 1);
  assertEquals(policy.credentials[0].name, "hf");
  assertEquals(policy.credentials[0].keychain, "resagent.gate.hf");
});

Deno.test("compile: the compiled example is enforceable by the reference gate", async () => {
  const m = await parseManifest(example);
  const policy = compileGates(m);
  const { ReferenceGate } = await import("./reference.ts");
  const g = new ReferenceGate();
  await g.applyPolicy(policy);

  const allowed = await g.evaluate({ host: "huggingface.co", http: { method: "GET", path: "/api/models" } });
  assertEquals(allowed.verdict, "allow");
  assertEquals(allowed.credential, "hf");

  const blocked = await g.evaluate({ host: "pastebin.com", http: { method: "POST", path: "/" } });
  assertEquals(blocked.verdict, "deny");
});
