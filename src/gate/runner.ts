/**
 * The gate corpus runner — apply the policy to a {@link GateController} and diff each case's verdict
 * against the corpus expectation. Gate-agnostic: give it the {@link "./reference.ts".ReferenceGate}
 * or the {@link "./clawpatrol.ts".ClawPatrolGate} and get the same report shape, exactly as the
 * storage conformance `runSuite` drives reference / workerd / celld.
 */

import type { GateController } from "./controller.ts";
import type { Corpus } from "./corpus.ts";
import type { Verdict } from "./policy.ts";

export interface GateCaseResult {
  name: string;
  ok: boolean;
  expected: Verdict;
  actual: Verdict;
  rule?: string;
  endpoint?: string;
  credential?: string;
  error?: string;
}

export interface GateReport {
  gate: string;
  total: number;
  passed: number;
  ok: boolean;
  cases: GateCaseResult[];
}

export async function runGateSuite(
  gate: GateController,
  corpus: Corpus,
): Promise<GateReport> {
  await gate.applyPolicy(corpus.policy);
  const cases: GateCaseResult[] = [];
  for (const c of corpus.cases) {
    try {
      const v = await gate.evaluate(c.facts);
      cases.push({
        name: c.name,
        ok: v.verdict === c.expect,
        expected: c.expect,
        actual: v.verdict,
        rule: v.rule,
        endpoint: v.endpoint,
        credential: v.credential,
      });
    } catch (e) {
      cases.push({
        name: c.name,
        ok: false,
        expected: c.expect,
        actual: "deny",
        error: (e as Error).message,
      });
    }
  }
  const passed = cases.filter((r) => r.ok).length;
  return {
    gate: gate.name,
    total: cases.length,
    passed,
    ok: passed === cases.length,
    cases,
  };
}

export function formatGateReport(report: GateReport): string {
  const lines = [`gate: ${report.gate} — ${report.passed}/${report.total} cases`];
  for (const c of report.cases) {
    const inject = c.credential ? ` (inject ${c.credential})` : "";
    lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name} → ${c.actual}${inject}`);
    if (!c.ok && c.error) lines.push(`      error: ${c.error}`);
    else if (!c.ok) lines.push(`      expected ${c.expected}, got ${c.actual}`);
  }
  lines.push(report.ok ? "PASS" : "FAIL");
  return lines.join("\n");
}
