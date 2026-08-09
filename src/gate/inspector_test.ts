import { assert, assertEquals } from "jsr:@std/assert@^1";
import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "./compile.ts";
import { policyToGateRules } from "./inspector.ts";
import { createDaemon, handleLine } from "../protocol/server.ts";
import { memoryBackend } from "../protocol/memory_backend.ts";
import { encode } from "../protocol/codec.ts";
import type { GateRuleInfo } from "../protocol/messages.ts";

const exampleUrl = new URL("../../examples/research-agent/resagent.hcl", import.meta.url);
const example = await Deno.readTextFile(exampleUrl);

Deno.test("inspector: policy lowers to typed gate rows", async () => {
  const policy = compileGates(await parseManifest(example));
  const rows = policyToGateRules(policy);

  const allow = rows.find((r) => r.verdict === "allow")!;
  assert(allow);
  assertEquals(allow.endpoint, "https.research-ResearchAgent");
  assert(allow.hosts.includes("huggingface.co"));
  assertEquals(allow.condition, 'http.method == "GET"');
  assertEquals(allow.credential, "hf");

  const deny = rows.find((r) => r.verdict === "deny")!;
  assert(deny);
  assertEquals(deny.priority, -100);
});

Deno.test("inspector: gate rows are served over the C5 protocol", async () => {
  const policy = compileGates(await parseManifest(example));
  const gate = policyToGateRules(policy);
  const handler = createDaemon(memoryBackend({ namespaces: [], gate }));

  const reply = await handleLine(
    encode({ id: 7, method: "gate.rules", params: {} }),
    handler,
  );
  const parsed = JSON.parse(reply) as { id: number; ok: boolean; result: GateRuleInfo[] };
  assertEquals(parsed.id, 7);
  assert(parsed.ok);
  assertEquals(parsed.result.length, gate.length);
  assert(parsed.result.some((r) => r.credential === "hf"));
});

Deno.test("inspector: a backend without a gate returns no rules", async () => {
  const handler = createDaemon(memoryBackend({ namespaces: [] }));
  const reply = await handleLine(
    encode({ id: 1, method: "gate.rules", params: {} }),
    handler,
  );
  const parsed = JSON.parse(reply) as { ok: boolean; result: GateRuleInfo[] };
  assert(parsed.ok);
  assertEquals(parsed.result, []);
});
