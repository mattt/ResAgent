/**
 * Lower the manifest's `serve` rules to `tailscale serve` command lines (M8) — the serve analog of
 * the wrangler/clawpatrol translators. Each serve rule maps its namespace path to the local tailnet
 * ingress, so the tailnet reaches objects through the identity-gated {@link "./ingress.ts"}.
 *
 *   deno task serve:translate <manifest.hcl>                 # print the commands (dry run)
 *   deno task serve:translate <manifest.hcl> --apply         # shell them via the Tailscale CLI
 *   deno task serve:translate <manifest.hcl> --status        # `tailscale status --json`, degraded
 *   deno task serve:translate <manifest.hcl> --funnel-i-consent   # include funnel (public) routes
 *
 * Funnel exposes a route to the public internet; funnel commands are emitted/applied ONLY behind
 * `--funnel-i-consent`, with a loud warning. `--apply`/`--status` shell out to
 * `TAILSCALE_BIN ?? /Applications/Tailscale.app/Contents/MacOS/Tailscale`, degrading gracefully when
 * the daemon isn't running or isn't logged in — the tailnet leg isn't verifiable in CI.
 */

import { parseManifest } from "../manifest/parse.ts";
import type { ServeRule } from "../manifest/types.ts";

export const DEFAULT_INGRESS = "127.0.0.1:8787";

const TAILSCALE_BIN = Deno.env.get("TAILSCALE_BIN") ??
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface ServeCommand {
  pattern: string;
  namespace: string;
  funnel: boolean;
  /** The `tailscale serve|funnel …` command line. */
  line: string;
}

/** Map serve rules to their `tailscale serve|funnel` command lines. */
export function serveCommands(
  serves: ServeRule[],
  ingress: string = DEFAULT_INGRESS,
): ServeCommand[] {
  return serves.map((s) => {
    const namespace = s.pattern.split("/")[0];
    const verb = s.funnel ? "funnel" : "serve";
    const line =
      `tailscale ${verb} --bg --set-path /${namespace} http://${ingress}/${namespace}`;
    return { pattern: s.pattern, namespace, funnel: s.funnel, line };
  });
}

async function tailscale(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await new Deno.Command(TAILSCALE_BIN, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return { code: r.code, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
  } catch (e) {
    return { code: 127, out: `tailscale not runnable (${(e as Error).message})` };
  }
}

/** `tailscale status --json`, degraded to a human line when the daemon is down or logged out. */
async function printStatus(): Promise<void> {
  const { code, out } = await tailscale(["status", "--json"]);
  if (code !== 0) {
    console.log(
      "tailscale: not running / not logged in (serve translation is still valid)",
    );
    return;
  }
  try {
    const j = JSON.parse(out) as { BackendState?: string; Self?: { DNSName?: string } };
    console.log(`tailscale backend: ${j.BackendState ?? "unknown"}`);
    if (j.Self?.DNSName) console.log(`this node: ${j.Self.DNSName.replace(/\.$/, "")}`);
  } catch {
    console.log("tailscale: status returned but was not JSON — is the CLI current?");
  }
}

if (import.meta.main) {
  const args = Deno.args;
  const file = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");
  const status = args.includes("--status");
  const funnelConsent = args.includes("--funnel-i-consent");

  if (status) {
    await printStatus();
    Deno.exit(0);
  }

  if (!file) {
    console.error("usage: deno task serve:translate <manifest.hcl> [--apply|--status]");
    Deno.exit(2);
  }

  const serves = (await parseManifest(await Deno.readTextFile(file))).serves;
  const commands = serveCommands(serves);
  if (commands.length === 0) {
    console.log(`${file}: no serve rules`);
    Deno.exit(0);
  }

  for (const cmd of commands) {
    if (cmd.funnel && !funnelConsent) {
      console.log(
        `# ${cmd.pattern} is FUNNEL-exposed (public internet) — omitted; pass --funnel-i-consent to include it`,
      );
      continue;
    }
    if (cmd.funnel) {
      console.log(
        `# ⚠ FUNNEL: ${cmd.pattern} will be reachable from the PUBLIC INTERNET`,
      );
    }
    console.log(cmd.line);
    if (apply) {
      const { code, out } = await tailscale(cmd.line.split(" ").slice(1));
      console.log(
        code === 0 ? "  → applied" : `  → failed (${out.trim() || "tailscale error"})`,
      );
    }
  }
}
