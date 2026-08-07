/**
 * Parse a ResAgent HCL manifest into the typed {@link Manifest} model (contract C4).
 *
 * Uses HashiCorp's hcl2json (Go→WASM, via @cdktf/hcl2json) for a faithful HCL parse, then maps its
 * output into our model. hcl2json nests labeled blocks and wraps block bodies in arrays
 * (`namespace.research[0].object.ResearchAgent[0]`); the helpers below navigate that defensively.
 */

import { parse as hclParse } from "@cdktf/hcl2json";
import type {
  AiBinding,
  AllowRule,
  DurableObjectDecl,
  FolderBinding,
  GateRule,
  Manifest,
  Namespace,
  ServeRule,
} from "./types.ts";

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
}

/** hcl2json gives every block body as an array (repeated blocks allowed); normalize to a list. */
function bodies(v: unknown): Json[] {
  if (Array.isArray(v)) return v.map(obj).filter((x): x is Json => x !== undefined);
  const o = obj(v);
  return o ? [o] : [];
}

function str(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : v == null ? dflt : String(v);
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)) : [];
}

export async function parseManifest(
  hclText: string,
  filename = "resagent.hcl",
): Promise<Manifest> {
  const root = (await hclParse(filename, hclText)) as Json;
  return {
    namespaces: parseNamespaces(root.namespace),
    gates: parseGates(root.gate),
    serves: parseServes(root.serve),
  };
}

function parseNamespaces(node: unknown): Namespace[] {
  const map = obj(node);
  if (!map) return [];
  return Object.entries(map).map(([name, val]) => {
    const objects: DurableObjectDecl[] = [];
    for (const body of bodies(val)) objects.push(...parseObjects(body.object));
    return { name, objects };
  });
}

function parseObjects(node: unknown): DurableObjectDecl[] {
  const map = obj(node);
  if (!map) return [];
  const out: DurableObjectDecl[] = [];
  for (const [name, val] of Object.entries(map)) {
    for (const body of bodies(val)) {
      const bnd = bodies(body.bindings)[0]; // `bindings` is an unlabeled block
      out.push({
        name,
        entrypoint: str(body.entrypoint),
        className: str(body.class, name),
        env: parseEnv(body.env),
        ai: parseAi(bnd?.ai),
        folders: parseFolders(bnd?.folder),
      });
    }
  }
  return out;
}

function parseEnv(node: unknown): Record<string, string> {
  const map = obj(node);
  const out: Record<string, string> = {};
  if (map) { for (const [k, v] of Object.entries(map)) out[k] = str(v); }
  return out;
}

function parseAi(node: unknown): AiBinding[] {
  const map = obj(node);
  if (!map) return [];
  const out: AiBinding[] = [];
  for (const [name, val] of Object.entries(map)) {
    for (const body of bodies(val)) out.push({ name, endpoint: str(body.endpoint) });
  }
  return out;
}

function parseFolders(node: unknown): FolderBinding[] {
  const map = obj(node);
  if (!map) return [];
  const out: FolderBinding[] = [];
  for (const [name, val] of Object.entries(map)) {
    for (const body of bodies(val)) {
      out.push({ name, grant: str(body.grant), mode: str(body.mode, "read-only") });
    }
  }
  return out;
}

function parseGates(node: unknown): GateRule[] {
  const map = obj(node);
  if (!map) return [];
  const out: GateRule[] = [];
  for (const [target, val] of Object.entries(map)) {
    for (const body of bodies(val)) {
      out.push({
        target,
        approver: body.approver != null ? str(body.approver) : undefined,
        denyDefault: body.deny_default === true,
        allow: parseAllow(body.allow),
      });
    }
  }
  return out;
}

function parseAllow(node: unknown): AllowRule[] {
  const map = obj(node);
  if (!map) return [];
  const out: AllowRule[] = [];
  for (const [protocol, val] of Object.entries(map)) {
    for (const body of bodies(val)) out.push({ protocol, hosts: strArray(body.hosts) });
  }
  return out;
}

function parseServes(node: unknown): ServeRule[] {
  const map = obj(node);
  if (!map) return [];
  const out: ServeRule[] = [];
  for (const [pattern, val] of Object.entries(map)) {
    for (const body of bodies(val)) {
      out.push({
        pattern,
        tailnetUsers: strArray(body.tailnet_users),
        funnel: body.funnel === true,
      });
    }
  }
  return out;
}
