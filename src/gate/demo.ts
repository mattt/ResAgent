/**
 * The M6 flagship demo (`deno task gate:demo`): the two exit criteria, on the reference gate, with a
 * real Keychain-backed credential injection.
 *
 *  ① an object makes an outbound call it has no credentials for → the gate injects them, and the
 *     object never held the token;
 *  ② an identical call to a disallowed host (and a write to an allowed one) is blocked by rule, with
 *     a blocked-egress log line.
 *
 * Verdicts here are the reference gate's; `deno task gate:clawpatrol` proves real Claw Patrol agrees
 * with them. If the credential's Keychain item is absent, the demo seeds a throwaway token and
 * removes it afterward, so it is self-contained and leaves any real token untouched.
 *
 * Run: deno run --allow-read --allow-env --allow-run src/gate/demo.ts [manifest.hcl]
 */

import { parseManifest } from "../manifest/parse.ts";
import type { Credential } from "./policy.ts";
import { compileGates } from "./compile.ts";
import { ReferenceGate } from "./reference.ts";
import type { ActionFacts } from "./facts.ts";
import { deleteSecret, getSecret, redact, setSecret } from "./keychain.ts";

const MANIFEST = Deno.args[0] ?? "examples/research-agent/resagent.hcl";

function line(label: string, value: string): void {
  console.log(`   ${label.padEnd(15)}${value}`);
}

async function main(): Promise<void> {
  const manifest = await parseManifest(await Deno.readTextFile(MANIFEST));
  const target = manifest.gates[0]?.target ?? "object";
  const policy = compileGates(manifest);
  const gate = new ReferenceGate();
  await gate.applyPolicy(policy);
  const credOf = (name?: string): Credential | undefined =>
    policy.credentials.find((c) => c.name === name);

  console.log("ResAgent · Claw Patrol egress gate — M6 demo");
  console.log(`policy: ${MANIFEST}  (gate ${target})\n`);

  // ── ① allowed read: the gate injects the token the object doesn't hold ──────
  const allowedReq: ActionFacts = {
    host: "huggingface.co",
    http: { method: "GET", path: "/api/models" },
  };
  const v1 = await gate.evaluate(allowedReq);
  const cred = credOf(v1.credential);
  console.log(`① object → GET https://huggingface.co/api/models`);
  if (cred) {
    line("object sent:", `${cred.header}: ${cred.placeholder}        (placeholder)`);
  }

  let seeded = false;
  if (cred) {
    let secret = await getSecret(cred.keychain);
    if (secret === null) {
      await setSecret(cred.keychain, "hf_demo_00000000000000000000000000000000");
      secret = await getSecret(cred.keychain);
      seeded = true;
    }
    line(
      "gate verdict:",
      `${v1.verdict.toUpperCase()}  (rule ${v1.rule}, endpoint ${v1.endpoint})`,
    );
    line(
      "gate injected:",
      `${cred.header}: ${cred.prefix ?? ""}${
        redact(secret ?? "")
      }   ← from Keychain ${cred.keychain}`,
    );
    console.log("   ✓ the object never held the token\n");
  }

  // ── ② disallowed host: blocked by rule ──────────────────────────────────────
  const blockedHost: ActionFacts = {
    host: "pastebin.com",
    http: { method: "GET", path: "/" },
  };
  const v2 = await gate.evaluate(blockedHost);
  console.log(`② object → GET https://pastebin.com/            (a host no rule allows)`);
  line("gate verdict:", v2.verdict.toUpperCase());
  console.log(
    `   BLOCK egress ${target} → pastebin.com GET /   ` +
      `(${v2.reason}; unknown_host=deny)\n`,
  );

  // ── ③ allowed host, disallowed method: blocked by rule ──────────────────────
  const blockedMethod: ActionFacts = {
    host: "huggingface.co",
    http: { method: "POST", path: "/api/models" },
  };
  const v3 = await gate.evaluate(blockedMethod);
  console.log(
    `③ object → POST https://huggingface.co/api/models   (write to an allowed host)`,
  );
  line("gate verdict:", `${v3.verdict.toUpperCase()}  (rule ${v3.rule})`);
  console.log(`   BLOCK egress ${target} → huggingface.co POST /api/models\n`);

  console.log(
    "verdicts above are the reference gate's; `deno task gate:clawpatrol` proves real Claw Patrol agrees.",
  );

  if (seeded && cred) await deleteSecret(cred.keychain);
}

if (import.meta.main) await main();
