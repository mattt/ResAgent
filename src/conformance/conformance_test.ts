/**
 * Tests for the conformance harness itself (contracts C1/C2).
 *
 * Two things must hold: (1) the reference engine passes the whole corpus — so the corpus is
 * well-formed and self-consistent; (2) a deliberately non-conforming engine is caught, with the
 * failing step's expected/actual surfaced — so the harness has teeth. When the workerd adapter is
 * wired, the same runSuite() call validates the oracle; when Celld's adapter lands, it measures it.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { cases } from "./cases.ts";
import { referenceEngine } from "./reference.ts";
import { formatReport, runSuite } from "./runner.ts";
import type { Engine } from "./engine.ts";
import type { Op, OpResult } from "./ops.ts";

Deno.test("the reference engine passes the entire corpus", async () => {
  const report = await runSuite(referenceEngine, cases);
  if (!report.ok) console.error(formatReport(report)); // surface diffs on failure
  assertEquals(report.passed, report.total);
  assert(report.ok);
});

Deno.test("every case has at least one step", () => {
  for (const c of cases) assert(c.steps.length > 0, `case "${c.name}" has no steps`);
});

// An engine that mishandles delete (always reports the key existed) must be caught.
const brokenEngine: Engine = {
  name: "broken",
  async create() {
    const inner = await referenceEngine.create();
    return {
      exec(objectId: string, op: Op): Promise<OpResult> {
        if (op.kind === "delete") return Promise.resolve(true);
        return inner.exec(objectId, op);
      },
      dispose: () => inner.dispose(),
    };
  },
};

Deno.test("a non-conforming engine is detected with a precise diff", async () => {
  const report = await runSuite(brokenEngine, cases);
  assert(!report.ok, "broken engine should not pass");
  assert(report.passed < report.total);

  const deleteCase = report.cases.find((c) => c.name === "delete semantics");
  assert(deleteCase && !deleteCase.ok, "delete-semantics case should fail");
  // The re-delete of an already-gone key should be false, but the broken engine claims true.
  const badDelete = deleteCase.steps.find((s) => s.op === "delete" && !s.ok);
  assert(badDelete, "a delete step should fail");
  assertEquals(badDelete.expected, false);
  assertEquals(badDelete.actual, true);

  assert(formatReport(report).includes("FAIL"));
});
