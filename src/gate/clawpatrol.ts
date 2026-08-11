/**
 * The real Claw Patrol oracle (M6) — the gate analog of `src/conformance/celld.ts`. It measures the
 * reference gate against real Claw Patrol two ways, both via Claw Patrol's own CLI (no live tunnel,
 * no system extension needed):
 *
 *  - `validatePolicyConfig` lowers the policy to `config.hcl` and runs `clawpatrol validate` — the
 *    translator's structure oracle (is the emitted config real?).
 *  - `runClawPatrolOracle` proves verdict equivalence: it evaluates the corpus on the reference gate,
 *    writes each case as a `clawpatrol test` fixture whose expected `match` is the reference's own
 *    `{verdict, rule, endpoint}`, and runs `clawpatrol test`. Exit 0 ⇒ real Claw Patrol agrees with
 *    the reference on every case. This is the intended use of `clawpatrol test` (drift detection),
 *    and — unlike a per-request probe — it carries the endpoint hint Claw Patrol needs to resolve
 *    wildcard hosts.
 *
 * Needs `clawpatrol` on disk (0.5.x; see `CLAWPATROL_BIN`) and run/read/write/env permissions.
 */

import type { ActionFacts } from "./facts.ts";
import type { VerdictResult } from "./controller.ts";
import type { Corpus } from "./corpus.ts";
import type { Policy } from "./policy.ts";
import { ReferenceGate } from "./reference.ts";
import { type ConfigOptions, toClawPatrolConfig } from "./clawpatrol_config.ts";
import type { GateReport } from "./runner.ts";

const HOME = Deno.env.get("HOME") ?? "";

export interface ClawPatrolOptions {
  clawpatrolBin?: string;
  config?: ConfigOptions;
}

/** Transport + defaults the emitted config carries so `clawpatrol validate` accepts it. */
const DEFAULT_CONFIG: ConfigOptions = {
  wireguard: { subnetCidr: "10.55.0.0/24", endpoint: "127.0.0.1:51820" },
  publicUrl: "https://127.0.0.1:8443",
  unknownHost: "deny",
  includeCredentials: true,
};

function resolveBin(opts: ClawPatrolOptions): string {
  return opts.clawpatrolBin ?? Deno.env.get("CLAWPATROL_BIN") ??
    `${HOME}/.local/bin/clawpatrol`;
}

async function assertBin(bin: string): Promise<void> {
  try {
    await Deno.stat(bin);
  } catch {
    throw new Error(`clawpatrol not found at ${bin} (set CLAWPATROL_BIN)`);
  }
}

async function run(bin: string, args: string[]): Promise<{ code: number; out: string }> {
  const path = `${HOME}/.local/bin:/opt/homebrew/bin:${Deno.env.get("PATH") ?? ""}`;
  const r = await new Deno.Command(bin, {
    args,
    env: { PATH: path },
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  const dec = new TextDecoder();
  return { code: r.code, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
}

/** Emit `config.hcl` from a policy and run `clawpatrol validate` on it. */
export async function validatePolicyConfig(
  policy: Policy,
  opts: ClawPatrolOptions = {},
): Promise<{ ok: boolean; out: string; config: string }> {
  const bin = resolveBin(opts);
  await assertBin(bin);
  const dir = await Deno.makeTempDir({ prefix: "resagent-gate-" });
  const config = `${dir}/config.hcl`;
  const cfg = { ...DEFAULT_CONFIG, ...opts.config, stateDir: `${dir}/state` };
  await Deno.writeTextFile(config, toClawPatrolConfig(policy, cfg));
  const v = await run(bin, ["validate", config]);
  return { ok: v.code === 0, out: v.out.trim(), config };
}

/** Serialize one case to a `clawpatrol test` fixture whose expected match is the reference output. */
function toFixture(
  facts: ActionFacts,
  expected: { verdict: string; rule?: string; endpoint?: string },
): unknown {
  const action: Record<string, unknown> = { host: facts.host };
  if (facts.credential) action.credential = facts.credential;
  if (facts.peer_ip) action.peer_ip = facts.peer_ip;
  if (facts.http) action.http = facts.http;
  if (facts.sql) action.sql = facts.sql;
  if (facts.k8s) action.k8s = facts.k8s;
  if (facts.ssh) action.ssh = facts.ssh;
  const match: Record<string, unknown> = { verdict: expected.verdict };
  if (expected.rule) match.rule = expected.rule;
  if (expected.endpoint) match.endpoint = expected.endpoint;
  return { action, match };
}

/**
 * Run the corpus through real Claw Patrol and report per-case agreement with the reference gate.
 * A case is `ok` when the reference matches the corpus expectation AND Claw Patrol matches the
 * reference (via `clawpatrol test`).
 */
export async function runClawPatrolOracle(
  corpus: Corpus,
  opts: ClawPatrolOptions = {},
): Promise<GateReport> {
  const bin = resolveBin(opts);
  await assertBin(bin);

  const ref = new ReferenceGate();
  await ref.applyPolicy(corpus.policy);

  // Claw Patrol replays only what it models — drop reference-only cases (e.g. Mac automation, M9).
  const replayCases = corpus.cases.filter((c) => !c.referenceOnly);

  const dir = await Deno.makeTempDir({ prefix: "resagent-gate-oracle-" });
  const config = `${dir}/config.hcl`;
  const cfg = { ...DEFAULT_CONFIG, ...opts.config, stateDir: `${dir}/state` };
  await Deno.writeTextFile(config, toClawPatrolConfig(corpus.policy, cfg));

  const v = await run(bin, ["validate", config]);
  if (v.code !== 0) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw new Error(`clawpatrol validate rejected the emitted config:\n${v.out}`);
  }

  const fixDir = `${dir}/fixtures`;
  await Deno.mkdir(fixDir);
  // reference output per case, and a fixture file whose basename indexes back to the case.
  const refOut: VerdictResult[] = [];
  for (let i = 0; i < replayCases.length; i++) {
    const c = replayCases[i];
    const out = await ref.evaluate(c.facts);
    refOut.push(out);
    const name = `${String(i).padStart(3, "0")}.json`;
    await Deno.writeTextFile(
      `${fixDir}/${name}`,
      JSON.stringify(toFixture(c.facts, out)),
    );
  }

  const t = await run(bin, ["test", config, fixDir]);
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // Parse per-fixture "ok"/"FAIL" lines; "FAIL <path>: <error>" also matches.
  const status = new Map<number, { ok: boolean; detail?: string }>();
  for (const line of t.out.split("\n")) {
    const m = line.match(/^(ok|FAIL)\s+(\S*?(\d{3})\.json)(?::\s*(.*))?/);
    if (m) status.set(Number(m[3]), { ok: m[1] === "ok", detail: m[4] });
  }

  const cases = replayCases.map((c, i) => {
    const refVerdict = refOut[i].verdict;
    const st = status.get(i);
    const refMatchesExpect = refVerdict === c.expect;
    const cpAgrees = st?.ok ?? false;
    return {
      name: c.name,
      ok: refMatchesExpect && cpAgrees,
      expected: c.expect,
      actual: refVerdict,
      rule: refOut[i].rule,
      endpoint: refOut[i].endpoint,
      credential: refOut[i].credential,
      error: !refMatchesExpect
        ? `reference gave ${refVerdict}, corpus expects ${c.expect}`
        : !cpAgrees
        ? `clawpatrol disagrees${st?.detail ? `: ${st.detail}` : ""}`
        : undefined,
    };
  });

  const passed = cases.filter((c) => c.ok).length;
  return {
    gate: "clawpatrol",
    total: cases.length,
    passed,
    ok: passed === cases.length,
    cases,
  };
}
