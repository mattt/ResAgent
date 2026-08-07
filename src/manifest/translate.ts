/**
 * CLI: translate a ResAgent HCL manifest to a `wrangler.toml` for `celld deploy`.
 *
 *   deno task translate <manifest.hcl> [namespace]
 *
 * Prints the wrangler.toml to stdout; warnings (dropped ResAgent-level blocks, var collisions) go
 * to stderr.
 */

import { parseManifest } from "./parse.ts";
import { toWrangler } from "./wrangler.ts";

if (import.meta.main) {
  const [file, namespace] = Deno.args;
  if (!file) {
    console.error("usage: deno task translate <manifest.hcl> [namespace]");
    Deno.exit(2);
  }
  const manifest = await parseManifest(await Deno.readTextFile(file), file);
  const { toml, warnings } = toWrangler(manifest, namespace);
  for (const w of warnings) console.error(`warning: ${w}`);
  console.log(toml);
}
