/**
 * CLI: lower a manifest's gate policy and check it with real `clawpatrol validate` (M6). This is the
 * translator's structure oracle — it proves the emitted config is a config Claw Patrol accepts.
 *
 *   deno task gate:validate <manifest.hcl>
 *
 * Exit 0 if Claw Patrol accepts the emitted config, 1 otherwise.
 */

import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "./compile.ts";
import { validatePolicyConfig } from "./clawpatrol.ts";

if (import.meta.main) {
  const file = Deno.args[0];
  if (!file) {
    console.error("usage: deno task gate:validate <manifest.hcl>");
    Deno.exit(2);
  }
  const manifest = await parseManifest(await Deno.readTextFile(file));
  const policy = compileGates(manifest);
  const { ok, out } = await validatePolicyConfig(policy);
  if (ok) {
    console.log(`${file}: ${out}`);
  } else {
    console.error(`${file}: clawpatrol validate rejected the emitted config:\n${out}`);
    Deno.exit(1);
  }
}
