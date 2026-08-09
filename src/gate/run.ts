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

if (import.meta.main) {
  const which = Deno.args[0] ?? "reference";
  const report = which === "clawpatrol"
    ? await runClawPatrolOracle(corpus)
    : await runGateSuite(new ReferenceGate(), corpus);
  console.log(formatGateReport(report));
  Deno.exit(report.ok ? 0 : 1);
}
