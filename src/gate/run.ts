/**
 * CLI: run the gate corpus (M6) — the gate analog of `src/conformance/run.ts`.
 *
 *   deno task gate:reference    # the in-process reference gate (defines correct verdicts)
 *   deno task gate:clawpatrol   # the SAME corpus on real Claw Patrol (the oracle), via clawpatrol test
 *
 * Exit 0 when every case matches, 1 otherwise.
 */

import { corpus } from "./corpus.ts";
import { formatGateReport, runGateSuite } from "./runner.ts";
import { ReferenceGate } from "./reference.ts";
import { runClawPatrolOracle } from "./clawpatrol.ts";
import { approverMap, resolveVerdict } from "./approver.ts";

/**
 * Print how each `approve` verdict resolves through its verdict chain (M7). Deterministic — the
 * corpus's approver is rule-based — so this stays CI-green alongside the reference gate.
 */
async function printResolvedChains(): Promise<void> {
  const gate = new ReferenceGate();
  await gate.applyPolicy(corpus.policy);
  const approvers = approverMap(corpus.policy.approvers);

  const lines: string[] = [];
  for (const c of corpus.cases) {
    const v = await gate.evaluate(c.facts);
    if (v.verdict !== "approve") continue;
    const res = await resolveVerdict(v, c.facts, approvers);
    const chain = res.chain.map((s) => `${s.approver}:${s.decision}`).join(" → ") ||
      "(no approver)";
    lines.push(`  ${c.name} → approve ⇒ ${res.final.toUpperCase()}  [${chain}]`);
  }
  if (lines.length) {
    console.log("\nverdict chains (RuleBasedApprover, deterministic):");
    console.log(lines.join("\n"));
  }
}

if (import.meta.main) {
  const which = Deno.args[0] ?? "reference";
  if (which === "clawpatrol") {
    const report = await runClawPatrolOracle(corpus);
    console.log(formatGateReport(report));
    Deno.exit(report.ok ? 0 : 1);
  }
  const report = await runGateSuite(new ReferenceGate(), corpus);
  console.log(formatGateReport(report));
  await printResolvedChains();
  Deno.exit(report.ok ? 0 : 1);
}
