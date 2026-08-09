import { assert, assertEquals } from "jsr:@std/assert@^1";
import { corpus } from "./corpus.ts";
import { runGateSuite } from "./runner.ts";
import { ReferenceGate } from "./reference.ts";

Deno.test("runner: the reference gate passes the whole corpus", async () => {
  const report = await runGateSuite(new ReferenceGate(), corpus);
  assert(
    report.ok,
    `reference gate failed cases: ${JSON.stringify(report.cases.filter((c) => !c.ok))}`,
  );
  assertEquals(report.passed, report.total);
});

Deno.test("runner: the hub GET case injects the hf credential", async () => {
  const report = await runGateSuite(new ReferenceGate(), corpus);
  const hubGet = report.cases.find((c) => c.name.startsWith("hub GET"));
  assertEquals(hubGet?.actual, "allow");
  assertEquals(hubGet?.credential, "hf");
});

Deno.test("runner: a broken gate is caught with expected-vs-actual", async () => {
  // A gate that allows everything must fail the deny cases.
  const alwaysAllow = {
    name: "always-allow",
    applyPolicy: () => Promise.resolve(),
    evaluate: () => Promise.resolve({ verdict: "allow" as const }),
  };
  const report = await runGateSuite(alwaysAllow, corpus);
  assert(!report.ok);
  const denyCase = report.cases.find((c) => c.expected === "deny");
  assertEquals(denyCase?.ok, false);
  assertEquals(denyCase?.actual, "allow");
});
