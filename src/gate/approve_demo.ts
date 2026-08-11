/**
 * The M7 flagship demo (`deno task gate:approve`): a borderline egress request escalates to a
 * verdict-chain approver, which resolves it to a final allow/deny.
 *
 * example manifest → compile → evaluate `POST https://huggingface.co/api/models` → the gate returns
 * the static `approve` verdict → resolve it through the manifest's `llm_approver` (the on-device
 * judge at its endpoint) if that endpoint is reachable, else a labeled deterministic
 * `RuleBasedApprover` fallback so the demo runs anywhere (CI, no model) → print the verdict-chain
 * trace and the resolved gate-log line the inspector's Gate → Log view would show.
 *
 * Run: deno run --allow-read --allow-env --allow-net src/gate/approve_demo.ts [manifest.hcl]
 */

import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "./compile.ts";
import { ReferenceGate } from "./reference.ts";
import type { ActionFacts } from "./facts.ts";
import type { ApproverSpec } from "./policy.ts";
import {
  type Approver,
  LlmApprover,
  resolveVerdict,
  RuleBasedApprover,
} from "./approver.ts";
import { GateLog, loggingGate, toGateLogEntries } from "./log.ts";

const MANIFEST = Deno.args[0] ?? "examples/research-agent/resagent.hcl";
const PROBE_MS = 500;

function line(label: string, value: string): void {
  console.log(`   ${label.padEnd(16)}${value}`);
}

/** Is an OpenAI-compatible approver endpoint up? A short-timeout /healthz probe. */
async function reachable(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/healthz`, {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const manifest = await parseManifest(await Deno.readTextFile(MANIFEST));
  const policy = compileGates(manifest);
  const log = new GateLog();
  const gate = loggingGate(new ReferenceGate(), log);
  await gate.applyPolicy(policy);

  console.log("ResAgent · verdict-chain approver — M7 demo");
  console.log(`policy: ${MANIFEST}\n`);

  const req: ActionFacts = {
    host: "huggingface.co",
    http: { method: "POST", path: "/api/models" },
  };
  console.log("① object → POST https://huggingface.co/api/models   (a Hub write)");
  const v = await gate.evaluate(req);
  line(
    "gate verdict:",
    `${v.verdict.toUpperCase()}  (rule ${v.rule}, approver ${
      (v.approvers ?? []).join(", ")
    })`,
  );

  // Prefer the manifest's llm_approver if reachable; otherwise a labeled deterministic fallback so
  // the trace prints anywhere. Both resolve the SAME static `approve` verdict.
  const name = v.approvers?.[0];
  const spec = policy.approvers?.find((a) => a.name === name);
  let approvers: Map<string, Approver>;
  if (spec?.type === "llm_approver" && spec.endpoint && await reachable(spec.endpoint)) {
    approvers = new Map([[spec.name, new LlmApprover(spec)]]);
    console.log(`\n② escalate → LlmApprover "${spec.name}" @ ${spec.endpoint}`);
  } else {
    const fallback: ApproverSpec = {
      name: name ?? "judge",
      type: "rule_based",
      allowWhen: 'http.path.startsWith("/api/")',
    };
    approvers = new Map([[fallback.name, new RuleBasedApprover(fallback)]]);
    const why = spec?.endpoint ? `${spec.endpoint} unreachable` : "no llm_approver";
    console.log(
      `\n② escalate → RuleBasedApprover "${fallback.name}"  (fallback — ${why})`,
    );
  }

  const resolution = await resolveVerdict(v, req, approvers);
  for (const step of resolution.chain) {
    line(
      `${step.approver}:`,
      `${step.decision.toUpperCase()}${step.rationale ? `  — ${step.rationale}` : ""}`,
    );
  }
  line("final verdict:", resolution.final.toUpperCase());

  // Fold the resolution back into the logged verdict — exactly what the inspector's Gate → Log view
  // renders (verdict approve → finalVerdict allow/deny).
  const record = log.entries().at(-1);
  if (record) {
    record.finalVerdict = resolution.final;
    record.approver = resolution.chain.at(-1)?.approver;
  }
  console.log("\n③ gate log entry:");
  console.log(`   ${JSON.stringify(toGateLogEntries(log.entries()).at(-1))}`);
}

if (import.meta.main) await main();
