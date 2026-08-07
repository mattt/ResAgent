/**
 * The conformance runner: apply each case's ops to an engine and diff results against the spec.
 *
 * Engine-agnostic — give it any {@link Engine} and the corpus, get a pass/fail report with the
 * exact op, expected, and actual for every failing step. This is the machinery that "runs green
 * against the reference / oracle and red-with-clear-gaps against a non-conforming engine".
 */

import { equal } from "jsr:@std/assert@^1";
import type { Engine } from "./engine.ts";
import type { Case } from "./cases.ts";

export interface StepResult {
  index: number;
  op: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

export interface CaseResult {
  name: string;
  ok: boolean;
  steps: StepResult[];
  error?: string;
}

export interface SuiteReport {
  engine: string;
  total: number;
  passed: number;
  ok: boolean;
  cases: CaseResult[];
}

export async function runCase(engine: Engine, c: Case): Promise<CaseResult> {
  const instance = await engine.create();
  const steps: StepResult[] = [];
  try {
    for (const [index, step] of c.steps.entries()) {
      const objectId = step.object ?? c.object ?? "A";
      const actual = await instance.exec(objectId, step.op);
      steps.push({
        index,
        op: step.op.kind,
        ok: equal(actual, step.expect),
        expected: step.expect,
        actual,
      });
    }
  } catch (e) {
    return { name: c.name, ok: false, steps, error: (e as Error).message };
  } finally {
    await instance.dispose();
  }
  return { name: c.name, ok: steps.every((s) => s.ok), steps };
}

export async function runSuite(engine: Engine, cases: Case[]): Promise<SuiteReport> {
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(engine, c));
  const passed = results.filter((r) => r.ok).length;
  return {
    engine: engine.name,
    total: results.length,
    passed,
    ok: passed === results.length,
    cases: results,
  };
}

export function formatReport(report: SuiteReport): string {
  const lines: string[] = [
    `conformance: ${report.engine} — ${report.passed}/${report.total} cases`,
  ];
  for (const c of report.cases) {
    lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}`);
    if (c.error) lines.push(`      error: ${c.error}`);
    for (const s of c.steps.filter((s) => !s.ok)) {
      lines.push(
        `      step ${s.index} (${s.op}): expected ${JSON.stringify(s.expected)}, ` +
          `got ${JSON.stringify(s.actual)}`,
      );
    }
  }
  lines.push(report.ok ? "PASS" : "FAIL");
  return lines.join("\n");
}
