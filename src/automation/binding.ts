/**
 * The gated automation binding (M9) — the one place a Mac automation request meets the gate.
 *
 * `gatedAutomation(gate, log, exec)` builds {@link ActionFacts} from an automation request (using the
 * `automation:*` host convention so the reference gate adjudicates it like any endpoint), evaluates
 * the gate, records the verdict to the {@link GateLog}, and only then runs the action via the
 * {@link AutomationExecutor}. A denied request throws {@link AutomationError} and is NEVER executed —
 * the executor is only ever handed already-allowed actions. This is the automation analog of the
 * egress gate's credential injection: the policy decides, the binding enforces.
 */

import type { ActionFacts } from "../gate/facts.ts";
import type { GateController } from "../gate/controller.ts";
import { GateLog } from "../gate/log.ts";
import type { AutomationExecutor, ExecResult } from "./executor.ts";

export interface AutomationRequest {
  kind: "shortcuts" | "osascript";
  /** Shortcut name (kind: "shortcuts"). */
  name?: string;
  /** osascript source (kind: "osascript"). */
  script?: string;
  /** Input passed to a shortcut. */
  input?: string;
}

export class AutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationError";
  }
}

/** The automation `host` the reference gate matches, from a request. */
export function automationHost(req: AutomationRequest): string {
  return req.kind === "shortcuts"
    ? `automation:shortcuts:${req.name ?? ""}`
    : "automation:osascript";
}

/** Build gate facts for an automation request. */
export function automationFacts(req: AutomationRequest): ActionFacts {
  return {
    host: automationHost(req),
    automation: {
      kind: req.kind,
      name: req.name,
      input: req.kind === "osascript" ? req.script : req.input,
    },
  };
}

export interface GatedAutomation {
  /** Gate + (if allowed) run the automation for `target`; throws {@link AutomationError} on deny. */
  run(target: string, req: AutomationRequest): Promise<ExecResult>;
}

export function gatedAutomation(
  gate: GateController,
  log: GateLog,
  exec: AutomationExecutor,
): GatedAutomation {
  return {
    async run(_target, req) {
      const facts = automationFacts(req);
      const verdict = await gate.evaluate(facts);
      log.record({ at: Date.now(), facts, result: verdict });
      if (verdict.verdict !== "allow") {
        throw new AutomationError(
          `automation ${automationHost(req)} denied: ${
            verdict.reason ?? verdict.verdict
          }`,
        );
      }
      return req.kind === "shortcuts"
        ? exec.runShortcut(req.name ?? "", req.input)
        : exec.runScript(req.script ?? "");
    },
  };
}
