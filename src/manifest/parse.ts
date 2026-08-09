/**
 * Parse a ResAgent HCL manifest into the typed {@link Manifest} model (contract C4).
 *
 * Uses HashiCorp's hcl2json (Go→WASM, via @cdktf/hcl2json) for a faithful HCL parse, then maps its
 * output into our model. hcl2json nests labeled blocks and wraps block bodies in arrays
 * (`namespace.research[0].object.ResearchAgent[0]`); the helpers below navigate that defensively.
 */

import { parse as hclParse } from "@cdktf/hcl2json";
import { bodies, type Json, obj, str, strArray } from "./hcl.ts";
import { ManifestError, validateRaw } from "./validate.ts";
import type {
  AiBinding,
  AllowRule,
  Credential,
  DurableObjectDecl,
  FolderBinding,
  GateRule,
  Manifest,
  Namespace,
  ServeRule,
} from "./types.ts";

export interface ParseOptions {
  filename?: string;
  /** Reject unknown/invalid keys against the manifest schema (default true). */
  strict?: boolean;
}

export async function parseManifest(
  hclText: string,
  opts: ParseOptions = {},
): Promise<Manifest> {
  const { filename = "resagent.hcl", strict = true } = opts;
  const root = (await hclParse(filename, hclText)) as Json;
  if (strict) {
    const issues = validateRaw(root);
    if (issues.length > 0) throw new ManifestError(issues, filename);
  }
  return {
    namespaces: parseNamespaces(root.namespace),
    gates: parseGates(root.gate),
    credentials: parseCredentials(root.credential),
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
    for (const body of bodies(val)) {
      out.push({
        protocol,
        hosts: strArray(body.hosts),
        condition: body.condition != null ? str(body.condition) : undefined,
        credential: body.credential != null ? str(body.credential) : undefined,
      });
    }
  }
  return out;
}

function parseCredentials(node: unknown): Credential[] {
  const map = obj(node);
  if (!map) return [];
  const out: Credential[] = [];
  for (const [name, val] of Object.entries(map)) {
    for (const body of bodies(val)) {
      out.push({
        name,
        type: str(body.type, "bearer_token") as Credential["type"],
        header: body.header != null ? str(body.header) : undefined,
        prefix: body.prefix != null ? str(body.prefix) : undefined,
        username: body.username != null ? str(body.username) : undefined,
        placeholder: str(body.placeholder),
        keychain: str(body.keychain),
      });
    }
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
