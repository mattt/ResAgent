import { assert, assertEquals } from "jsr:@std/assert@^1";
import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "./compile.ts";

const exampleUrl = new URL("../../examples/research-agent/resagent.hcl", import.meta.url);
const example = await Deno.readTextFile(exampleUrl);

Deno.test("compile: the example manifest lowers to a policy", async () => {
  const m = await parseManifest(example);
  const policy = compileGates(m);

  // Two endpoints: the allow host-group and the approve host-group (M7 escalation).
  assertEquals(policy.endpoints.length, 2);
  const allowEp = policy.endpoints[0];
  assertEquals(allowEp.type, "https");
  assert(allowEp.hosts.includes("huggingface.co"));
  assert(allowEp.hosts.includes("*.hf.co"));

  // An allow rule (with condition + credential) and a global default-deny.
  const allow = policy.rules.find((r) => r.verdict === "allow");
  assert(allow);
  assertEquals(allow!.endpoint, allowEp.name);
  assertEquals(allow!.condition, 'http.method == "GET"');
  assertEquals(allow!.credential, "hf");

  const deny = policy.rules.find((r) => r.verdict === "deny");
  assert(deny);
  assertEquals(deny!.endpoint, allowEp.name); // per-endpoint catch-all (no global Claw Patrol rule)
  assertEquals(deny!.priority, -100);

  // An approve rule at priority -50 (between allow 0 and deny -100), carrying the gate's approver.
  const approve = policy.rules.find((r) => r.verdict === "approve");
  assert(approve);
  assertEquals(approve!.priority, -50);
  assertEquals(approve!.condition, 'http.method == "POST"');
  assertEquals(approve!.approvers, ["local-judge"]);

  // The approver spec is carried through for resolution (M7).
  assertEquals(policy.approvers?.length, 1);
  assertEquals(policy.approvers![0].name, "local-judge");
  assertEquals(policy.approvers![0].type, "llm_approver");

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

  const allowed = await g.evaluate({
    host: "huggingface.co",
    http: { method: "GET", path: "/api/models" },
  });
  assertEquals(allowed.verdict, "allow");
  assertEquals(allowed.credential, "hf");

  const blocked = await g.evaluate({
    host: "pastebin.com",
    http: { method: "POST", path: "/" },
  });
  assertEquals(blocked.verdict, "deny");
});
