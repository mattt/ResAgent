/**
 * The gated automation binding (M9): an allowed action runs; a denied action throws and the executor
 * is NEVER called (the exit-criterion — the gate, not the executor, is the boundary). Both verdicts
 * are recorded to the gate log. CI-safe (fake executor, no subprocess).
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { AutomationError, gatedAutomation } from "./binding.ts";
import type { AutomationExecutor, ExecResult } from "./executor.ts";
import { ReferenceGate } from "../gate/reference.ts";
import { GateLog } from "../gate/log.ts";
import { corpus } from "../gate/corpus.ts";

/** Records every call so we can assert a denied action never reaches it. */
function spyExecutor(): AutomationExecutor & { calls: string[] } {
  const calls: string[] = [];
  const ok = (label: string): ExecResult => {
    calls.push(label);
    return { code: 0, stdout: `ran ${label}`, stderr: "" };
  };
  return {
    calls,
    runShortcut: (name) => Promise.resolve(ok(`shortcut:${name}`)),
    runScript: (script) => Promise.resolve(ok(`script:${script}`)),
  };
}

async function boundGate() {
  const gate = new ReferenceGate();
  await gate.applyPolicy(corpus.policy);
  return gate;
}

Deno.test("binding: a listed shortcut is gated-allowed and executed", async () => {
  const gate = await boundGate();
  const log = new GateLog();
  const exec = spyExecutor();
  const auto = gatedAutomation(gate, log, exec);

  const res = await auto.run("research/ResearchAgent", {
    kind: "shortcuts",
    name: "Daily Digest",
  });
  assertEquals(res.stdout, "ran shortcut:Daily Digest");
  assertEquals(exec.calls, ["shortcut:Daily Digest"]);
  assertEquals(log.entries().at(-1)?.result.verdict, "allow");
});

Deno.test("binding: an unlisted shortcut is denied and the executor is never called", async () => {
  const gate = await boundGate();
  const log = new GateLog();
  const exec = spyExecutor();
  const auto = gatedAutomation(gate, log, exec);

  await assertRejects(
    () => auto.run("research/ResearchAgent", { kind: "shortcuts", name: "Wipe Disk" }),
    AutomationError,
    "denied",
  );
  assertEquals(exec.calls, []); // ← the exit criterion: no execution of a denied action
  assertEquals(log.entries().at(-1)?.result.verdict, "deny");
});

Deno.test("binding: an allowed osascript runs", async () => {
  const gate = await boundGate();
  const exec = spyExecutor();
  const auto = gatedAutomation(gate, new GateLog(), exec);
  const res = await auto.run("research/ResearchAgent", {
    kind: "osascript",
    script: "1+1",
  });
  assert(res.stdout.includes("script:1+1"));
  assertEquals(exec.calls, ["script:1+1"]);
});
