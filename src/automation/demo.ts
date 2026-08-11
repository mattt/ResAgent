/**
 * The M9 flagship demo (`deno task automation:demo`): the gate brokers Mac automation.
 *
 *  ① a rule-allowed osascript runs (the example's `allow "automation" { scripts = true }`);
 *  ② an unlisted Shortcut is refused BY RULE and never executed.
 *
 * This is the M9 exit criterion minus the TCC visual (the first real Shortcut/AppleScript may raise a
 * one-time permission prompt — a user action). Verdicts are the reference gate's, recorded to the
 * gate log exactly as the daemon would serve them over `gate.log`.
 *
 * Run: deno run --allow-read --allow-env --allow-run src/automation/demo.ts [manifest.hcl]
 */

import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "../gate/compile.ts";
import { ReferenceGate } from "../gate/reference.ts";
import { GateLog, toGateLogEntries } from "../gate/log.ts";
import { gatedAutomation } from "./binding.ts";
import { systemExecutor } from "./executor.ts";

const MANIFEST = Deno.args[0] ?? "examples/research-agent/resagent.hcl";

async function main(): Promise<void> {
  const policy = compileGates(await parseManifest(await Deno.readTextFile(MANIFEST)));
  const gate = new ReferenceGate();
  await gate.applyPolicy(policy);
  const log = new GateLog();
  const auto = gatedAutomation(gate, log, systemExecutor());

  console.log("ResAgent · gated Mac automation — M9 demo");
  console.log(`policy: ${MANIFEST}\n`);

  console.log(
    '① object → run osascript `1 + 1`   (allow "automation" { scripts = true })',
  );
  try {
    const r = await auto.run("research/ResearchAgent", {
      kind: "osascript",
      script: "1 + 1",
    });
    console.log(
      `   ALLOW → osascript exited ${r.code}, stdout ${JSON.stringify(r.stdout)}\n`,
    );
  } catch (e) {
    console.log(`   unexpected error: ${(e as Error).message}\n`);
  }

  console.log('② object → run Shortcut "Wipe Disk"   (not in the allow-list)');
  try {
    await auto.run("research/ResearchAgent", { kind: "shortcuts", name: "Wipe Disk" });
    console.log("   unexpected: the Shortcut ran\n");
  } catch (e) {
    console.log(`   BLOCK by rule → ${(e as Error).message}\n`);
  }

  console.log("gate log (what the inspector's Gate → Log tab would show):");
  for (const e of toGateLogEntries(log.entries())) console.log(`  ${JSON.stringify(e)}`);
}

if (import.meta.main) await main();
