/**
 * Lower a {@link Manifest} to a `wrangler.toml` for `celld deploy` (contract C4, M2).
 *
 * Only the deploy-relevant subset is emitted: name, entry, compatibility date, Durable Object
 * bindings, the SQLite migration, and merged `[vars]`. The ai/folder bindings, gate rules, and
 * serve/identity rules are ResAgent-level — they configure the env.AI injector, folder-grant store,
 * Claw Patrol, and Tailscale, NOT the deploy — so they are deliberately not written here. Anything
 * dropped is surfaced as a warning rather than silently omitted.
 */

import { stringify } from "@std/toml";
import type { Manifest, Namespace } from "./types.ts";

/** Compatibility date pinned for reproducible deploys; bump deliberately. */
const COMPATIBILITY_DATE = "2025-06-01";

export interface WranglerResult {
  toml: string;
  warnings: string[];
}

function pickNamespace(manifest: Manifest, name?: string): Namespace {
  if (name) {
    const ns = manifest.namespaces.find((n) => n.name === name);
    if (!ns) throw new Error(`no namespace "${name}" in manifest`);
    return ns;
  }
  if (manifest.namespaces.length === 1) return manifest.namespaces[0];
  const names = manifest.namespaces.map((n) => n.name).join(", ");
  throw new Error(`manifest has multiple namespaces (${names}); pass one to translate`);
}

export function toWrangler(manifest: Manifest, namespaceName?: string): WranglerResult {
  const ns = pickNamespace(manifest, namespaceName);
  const warnings: string[] = [];

  if (ns.objects.length === 0) {
    throw new Error(`namespace "${ns.name}" declares no objects`);
  }

  // celld deploys one Worker per fleet; all objects in a namespace share one entry module.
  const entrypoints = [...new Set(ns.objects.map((o) => o.entrypoint))];
  if (entrypoints.length > 1) {
    throw new Error(
      `namespace "${ns.name}" objects must share one entrypoint for celld deploy; ` +
        `found: ${entrypoints.join(", ")}`,
    );
  }

  // Merge per-object env into [vars] (stock wrangler has no per-DO vars).
  const vars: Record<string, string> = {};
  for (const o of ns.objects) {
    for (const [k, v] of Object.entries(o.env)) {
      if (k in vars && vars[k] !== v) {
        warnings.push(`var "${k}" overridden across objects`);
      }
      vars[k] = v;
    }
    if (o.ai.length || o.folders.length) {
      warnings.push(
        `object "${o.name}": ai/folder bindings are ResAgent-level; not emitted to wrangler.toml`,
      );
    }
  }

  const config: Record<string, unknown> = {
    name: ns.name,
    main: entrypoints[0],
    compatibility_date: COMPATIBILITY_DATE,
    durable_objects: {
      bindings: ns.objects.map((o) => ({ name: o.name, class_name: o.className })),
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ns.objects.map((o) => o.className) }],
  };
  if (Object.keys(vars).length > 0) config.vars = vars;

  return { toml: stringify(config), warnings };
}
