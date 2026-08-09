/**
 * CLI: lower a ResAgent manifest's gate policy to Claw Patrol `config.hcl` (M6).
 *
 *   deno task gate:translate <manifest.hcl>   # prints config.hcl to stdout
 *
 * Pair with `clawpatrol validate` (see `deno task gate:validate`) to confirm the emitted config is
 * real. Secret values are never emitted — credential blocks only declare shape; the gateway loads
 * the real secret from Keychain at apply time.
 */

import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "./compile.ts";
import { type ConfigOptions, toClawPatrolConfig } from "./clawpatrol_config.ts";

export async function translateManifest(
  path: string,
  opts: ConfigOptions = {},
): Promise<string> {
  const manifest = await parseManifest(await Deno.readTextFile(path));
  return toClawPatrolConfig(compileGates(manifest), opts);
}

if (import.meta.main) {
  const file = Deno.args[0];
  if (!file) {
    console.error("usage: deno task gate:translate <manifest.hcl>");
    Deno.exit(2);
  }
  console.log(await translateManifest(file, { includeCredentials: true }));
}
