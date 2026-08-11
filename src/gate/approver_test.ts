/**
 * Verdict-chain approvers (M7): the RuleBasedApprover truth table, resolveVerdict pass-through /
 * deny-closed / AND-chain short-circuit, reply parsing, and LlmApprover against an in-test fake
 * OpenAI backend (ALLOW / DENY / garbage ⇒ deny, unreachable ⇒ deny). CI-safe.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type Approver,
  approverMap,
  LlmApprover,
  parseDecision,
  resolveVerdict,
  RuleBasedApprover,
} from "./approver.ts";
import type { ActionFacts } from "./facts.ts";
import type { VerdictResult } from "./controller.ts";

const post: ActionFacts = {
  host: "huggingface.co",
  http: { method: "POST", path: "/api/models" },
};
const del: ActionFacts = {
  host: "huggingface.co",
  http: { method: "DELETE", path: "/secret" },
};

Deno.test("RuleBasedApprover: allow_when decides; absent ⇒ deny-closed", async () => {
  const judge = new RuleBasedApprover({
    name: "judge",
    type: "rule_based",
    allowWhen: 'http.path.startsWith("/api/")',
  });
  assertEquals((await judge.review(post)).decision, "allow");
  assertEquals((await judge.review(del)).decision, "deny");

  const silent = new RuleBasedApprover({ name: "silent", type: "rule_based" });
  assertEquals((await silent.review(post)).decision, "deny");
});

Deno.test("parseDecision: leading ALLOW/DENY wins, anything else denies closed", () => {
  assertEquals(parseDecision("ALLOW: read-only Hub call").decision, "allow");
  assertEquals(parseDecision("DENY - writes off-device").decision, "deny");
  assertEquals(parseDecision("I think maybe?").decision, "deny");
  assertEquals(parseDecision("").decision, "deny");
  assertEquals(parseDecision("ALLOW").rationale, undefined);
});

Deno.test("resolveVerdict: allow/deny pass through, approve runs the chain", async () => {
  const approvers = approverMap([{
    name: "judge",
    type: "rule_based",
    allowWhen: 'http.path.startsWith("/api/")',
  }]);
  const approve = (extra: Partial<VerdictResult> = {}): VerdictResult => ({
    verdict: "approve",
    approvers: ["judge"],
    ...extra,
  });

  assertEquals(
    (await resolveVerdict({ verdict: "allow" }, post, approvers)).final,
    "allow",
  );
  assertEquals(
    (await resolveVerdict({ verdict: "passthrough" }, post, approvers)).final,
    "allow",
  );
  assertEquals(
    (await resolveVerdict({ verdict: "deny" }, post, approvers)).final,
    "deny",
  );

  // approve → judge allows (path under /api/)
  const ok = await resolveVerdict(approve(), post, approvers);
  assertEquals(ok.final, "allow");
  assertEquals(ok.chain, [{
    approver: "judge",
    decision: "allow",
    rationale: "allow_when held",
  }]);

  // approve → judge denies (path not under /api/)
  assertEquals((await resolveVerdict(approve(), del, approvers)).final, "deny");

  // approve with no approver named, or an unknown approver ⇒ deny-closed
  assertEquals(
    (await resolveVerdict(approve({ approvers: [] }), post, approvers)).final,
    "deny",
  );
  const unknown = await resolveVerdict(
    approve({ approvers: ["ghost"] }),
    post,
    approvers,
  );
  assertEquals(unknown.final, "deny");
  assertEquals(unknown.chain[0].rationale, "unknown approver");
});

Deno.test("resolveVerdict: AND-chain short-circuits on the first deny", async () => {
  let secondCalled = false;
  const yes: Approver = {
    name: "yes",
    review: () => Promise.resolve({ decision: "allow" }),
  };
  const no: Approver = {
    name: "no",
    review: () => Promise.resolve({ decision: "deny" }),
  };
  const spy: Approver = {
    name: "spy",
    review: () => {
      secondCalled = true;
      return Promise.resolve({ decision: "allow" });
    },
  };
  const map = new Map([[yes.name, yes], [no.name, no], [spy.name, spy]]);
  const res = await resolveVerdict(
    { verdict: "approve", approvers: ["yes", "no", "spy"] },
    post,
    map,
  );
  assertEquals(res.final, "deny");
  assertEquals(res.chain.map((s) => s.approver), ["yes", "no"]); // stopped at the first deny
  assert(!secondCalled);
});

// ── LlmApprover against a fake OpenAI backend ────────────────────────────────

function fakeBackend(reply: string): { url: string; stop: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/healthz") return new Response("ok");
      return Response.json({
        choices: [{ message: { role: "assistant", content: reply } }],
      });
    },
  );
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    stop: () => server.shutdown(),
  };
}

Deno.test("LlmApprover: ALLOW/DENY/garbage replies map to decisions", async () => {
  for (
    const [reply, want] of [
      ["ALLOW: read-only", "allow"],
      ["DENY: too risky", "deny"],
      ["¯\\_(ツ)_/¯", "deny"],
    ] as const
  ) {
    const be = fakeBackend(reply);
    try {
      const approver = new LlmApprover({
        name: "j",
        type: "llm_approver",
        endpoint: be.url,
      });
      assertEquals((await approver.review(post)).decision, want);
    } finally {
      await be.stop();
    }
  }
});

Deno.test("LlmApprover: an unreachable endpoint denies closed", async () => {
  const approver = new LlmApprover({
    name: "j",
    type: "llm_approver",
    endpoint: "http://127.0.0.1:1", // nothing listening
  });
  const d = await approver.review(post);
  assertEquals(d.decision, "deny");
  assert(d.rationale?.includes("unreachable"));
});
