/**
 * The gate verdict log (M6 polish): ring-buffer eviction, the logging decorator records each
 * verdict, and the C5 lowering flattens records to wire rows. CI-safe.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { GateLog, loggingGate, toGateLogEntries } from "./log.ts";
import { ReferenceGate } from "./reference.ts";
import { corpus } from "./corpus.ts";

Deno.test("GateLog is a bounded newest-last ring buffer", () => {
  const log = new GateLog(3);
  for (let i = 0; i < 5; i++) {
    log.record({
      at: i,
      facts: { host: `h${i}` },
      result: { verdict: "allow" },
    });
  }
  assertEquals(log.size, 3);
  assertEquals(log.entries().map((r) => r.at), [2, 3, 4]); // oldest two evicted
  assertEquals(log.entries(2).map((r) => r.at), [3, 4]); // limit keeps the most recent
});

Deno.test("loggingGate records each evaluate's request and verdict", async () => {
  const log = new GateLog();
  const gate = loggingGate(new ReferenceGate(), log);
  await gate.applyPolicy(corpus.policy);

  for (const c of corpus.cases) await gate.evaluate(c.facts);
  assertEquals(log.size, corpus.cases.length);

  const entries = toGateLogEntries(log.entries());
  // Every corpus case is a claimed-host HTTP request, so method/path/host round-trip.
  const first = entries[0];
  assertEquals(first.host, corpus.cases[0].facts.host);
  assertEquals(first.method, corpus.cases[0].facts.http!.method);
  assertEquals(first.verdict, corpus.cases[0].expect);
  // A denied case carries its rule/reason; an allowed hub case carries the injected credential.
  assert(entries.some((e) => e.verdict === "deny" && e.reason));
  assert(entries.some((e) => e.verdict === "allow" && e.credential === "hf"));
});

Deno.test("toGateLogEntries preserves an approver-resolved final verdict", () => {
  const log = new GateLog();
  log.record({
    at: 1,
    facts: { host: "huggingface.co", http: { method: "POST", path: "/api/models" } },
    result: { verdict: "approve", rule: "hub-approve" },
    finalVerdict: "deny",
    approver: "judge",
  });
  const [e] = toGateLogEntries(log.entries());
  assertEquals(e.verdict, "approve");
  assertEquals(e.finalVerdict, "deny");
  assertEquals(e.approver, "judge");
});
