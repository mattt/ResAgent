/**
 * CLI: run the conformance corpus against an engine and print a report.
 *
 *   deno task conformance [engine]
 *
 * Engines: "reference" (default, in-memory) · "workerd" (oracle, needs the binary). Celld and the
 * Swift core plug in here as their adapters land. Exit code is non-zero if any case fails.
 */

import { cases } from "./cases.ts";
import { referenceEngine } from "./reference.ts";
import { workerdEngine } from "./workerd.ts";
import { celldEngine } from "./celld.ts";
import { formatReport, runSuite } from "./runner.ts";
import type { Engine } from "./engine.ts";

function engineByName(name: string): Engine {
  switch (name) {
    case "reference":
      return referenceEngine;
    case "workerd":
      return workerdEngine();
    case "celld":
      return celldEngine();
    default:
      throw new Error(`unknown engine "${name}" (have: reference, workerd, celld)`);
  }
}

if (import.meta.main) {
  const engine = engineByName(Deno.args[0] ?? "reference");
  try {
    const report = await runSuite(engine, cases);
    console.log(formatReport(report));
    await engine.close?.();
    Deno.exit(report.ok ? 0 : 1);
  } catch (e) {
    await engine.close?.();
    throw e;
  }
}
