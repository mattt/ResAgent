/**
 * The folder-grants CLI (M10, `deno task grants`) — the grant-flow stand-in until a GUI shell pass.
 *
 *   deno task grants list                         # every grant (path, mode, granted-at)
 *   deno task grants add <path> [--read-write]    # grant a folder (default read-only)
 *   deno task grants revoke <path>                # revoke a folder
 *   deno task grants check <manifest.hcl>         # diff the manifest's folder bindings vs the store
 *
 * `check` is the honest audit: it lists every `folder { grant = … }` a manifest declares and reports
 * whether the store actually covers it at the declared mode — so a manifest can't claim access the
 * user never granted.
 */

import { canonicalize, fileGrantStore } from "./grants.ts";
import { parseManifest } from "../manifest/parse.ts";

function printGrant(g: { path: string; mode: string; grantedAt: number }): void {
  const when = new Date(g.grantedAt).toISOString().slice(0, 10);
  console.log(`  ${g.mode === "read-write" ? "rw" : "ro"}  ${g.path}  (granted ${when})`);
}

async function checkManifest(file: string): Promise<number> {
  const store = fileGrantStore();
  const manifest = await parseManifest(await Deno.readTextFile(file));
  const bindings = manifest.namespaces
    .flatMap((n) => n.objects)
    .flatMap((o) => o.folders.map((f) => ({ object: o.name, ...f })));

  if (bindings.length === 0) {
    console.log(`${file}: no folder bindings`);
    return 0;
  }
  let missing = 0;
  for (const b of bindings) {
    const mode = b.mode === "read-write" ? "read-write" : "read-only";
    const c = store.check(b.grant, mode);
    const label = `${b.object}.${b.name} → ${b.grant} (${mode})`;
    if (c.allowed) {
      console.log(`  ✓ ${label}`);
    } else {
      console.log(`  ✗ ${label} — ${c.reason}`);
      missing++;
    }
  }
  console.log(
    missing === 0
      ? "all folder bindings are granted"
      : `${missing} folder binding(s) NOT granted — run \`grants add\``,
  );
  return missing === 0 ? 0 : 1;
}

if (import.meta.main) {
  const [cmd, arg] = Deno.args;
  const store = fileGrantStore();

  switch (cmd) {
    case "list": {
      const grants = store.list();
      if (grants.length === 0) console.log("no grants");
      else grants.forEach(printGrant);
      break;
    }
    case "add": {
      if (!arg) {
        console.error("usage: grants add <path> [--read-write]");
        Deno.exit(2);
      }
      const mode = Deno.args.includes("--read-write") ? "read-write" : "read-only";
      const g = store.grant(arg, mode);
      console.log(`granted ${g.mode}:`);
      printGrant(g);
      break;
    }
    case "revoke": {
      if (!arg) {
        console.error("usage: grants revoke <path>");
        Deno.exit(2);
      }
      console.log(store.revoke(arg) ? `revoked ${canonicalize(arg)}` : "no such grant");
      break;
    }
    case "check": {
      if (!arg) {
        console.error("usage: grants check <manifest.hcl>");
        Deno.exit(2);
      }
      Deno.exit(await checkManifest(arg));
      break;
    }
    default:
      console.error("usage: grants <list|add|revoke|check> …");
      Deno.exit(2);
  }
}
