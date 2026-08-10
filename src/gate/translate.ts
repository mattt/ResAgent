/**
 * CLI: lower a ResAgent manifest's gate policy to Claw Patrol `config.hcl` (M6).
 *
 *   deno task gate:translate <manifest.hcl>             # policy-only config to stdout
 *   deno task gate:translate --gateway <manifest.hcl>   # + a loopback WireGuard transport so the
 *                                                        #   config is bootable with `clawpatrol gateway`
 *
 * Pair with `clawpatrol validate` (see `deno task gate:validate`) to confirm the emitted config is
 * real. Secret values are never emitted — credential blocks only declare shape; the gateway loads
 * the real secret from Keychain at apply time.
 */

import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "./compile.ts";
import { type ConfigOptions, toClawPatrolConfig } from "./clawpatrol_config.ts";

/** Loopback transport for a single-Mac gateway boot (`clawpatrol gateway`). */
export const LOOPBACK_GATEWAY: ConfigOptions = {
  dashboardListen: "127.0.0.1:8080",
  publicUrl: "https://127.0.0.1:8443",
  wireguard: { subnetCidr: "10.55.0.0/24", endpoint: "127.0.0.1:51820" },
  unknownHost: "deny",
  includeCredentials: true,
};

export async function translateManifest(
  path: string,
  opts: ConfigOptions = {},
): Promise<string> {
  const manifest = await parseManifest(await Deno.readTextFile(path));
  return toClawPatrolConfig(compileGates(manifest), opts);
}

if (import.meta.main) {
  const gateway = Deno.args.includes("--gateway");
  const file = Deno.args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: deno task gate:translate [--gateway] <manifest.hcl>");
    Deno.exit(2);
  }
  const opts = gateway ? LOOPBACK_GATEWAY : { includeCredentials: true };
  console.log(await translateManifest(file, opts));
}
