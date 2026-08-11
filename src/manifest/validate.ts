/**
 * Strict schema validation for ResAgent manifests (contract C4).
 *
 * Runs on the RAW hcl2json tree — not the typed model — because the model has already dropped
 * unknown keys, and catching those is the whole point. Every block type has an allow-list of keys
 * and per-key type rules; violations become {@link ManifestIssue}s with a dotted path. This is the
 * check that turns C4 from "it parses" into "it's valid or it's rejected".
 *
 *   deno task validate <manifest.hcl>
 */

import { parse as hclParse } from "@cdktf/hcl2json";
import { bodies, type Json, obj } from "./hcl.ts";

export interface ManifestIssue {
  /** Dotted path to the offending node, e.g. "namespace.research.object.Foo.entrypoint". */
  path: string;
  message: string;
}

export class ManifestError extends Error {
  constructor(public readonly issues: ManifestIssue[], filename = "manifest") {
    super(`${filename}: ${issues.length} schema error(s)\n${formatIssues(issues)}`);
    this.name = "ManifestError";
  }
}

export function formatIssues(issues: ManifestIssue[]): string {
  return issues.map((i) => `  - ${i.path || "<root>"}: ${i.message}`).join("\n");
}

// ── Key/type checkers ────────────────────────────────────────────────────────

function unknownKeys(
  path: string,
  body: Json,
  allowed: string[],
  out: ManifestIssue[],
): void {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) {
      out.push({ path: path ? `${path}.${k}` : k, message: `unknown key "${k}"` });
    }
  }
}

function checkString(
  path: string,
  body: Json,
  key: string,
  out: ManifestIssue[],
  required = false,
): void {
  if (!(key in body)) {
    if (required) out.push({ path: `${path}.${key}`, message: "required" });
    return;
  }
  if (typeof body[key] !== "string") {
    out.push({ path: `${path}.${key}`, message: "must be a string" });
  }
}

function checkBool(path: string, body: Json, key: string, out: ManifestIssue[]): void {
  if (key in body && typeof body[key] !== "boolean") {
    out.push({ path: `${path}.${key}`, message: "must be a boolean" });
  }
}

function checkStringArray(
  path: string,
  body: Json,
  key: string,
  out: ManifestIssue[],
  required = false,
): void {
  if (!(key in body)) {
    if (required) out.push({ path: `${path}.${key}`, message: "required" });
    return;
  }
  const v = body[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    out.push({ path: `${path}.${key}`, message: "must be an array of strings" });
  }
}

function checkStringMap(
  path: string,
  body: Json,
  key: string,
  out: ManifestIssue[],
): void {
  if (!(key in body)) return;
  const m = obj(body[key]);
  if (!m) {
    out.push({ path: `${path}.${key}`, message: "must be a map of strings" });
    return;
  }
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== "string") {
      out.push({ path: `${path}.${key}.${k}`, message: "must be a string" });
    }
  }
}

function checkEnum(
  path: string,
  body: Json,
  key: string,
  allowed: string[],
  out: ManifestIssue[],
): void {
  if (!(key in body)) return;
  const v = body[key];
  if (typeof v !== "string" || !allowed.includes(v)) {
    out.push({
      path: `${path}.${key}`,
      message: `must be one of: ${allowed.join(", ")}`,
    });
  }
}

/** Walk a labeled block `{ label: [body,...] }`, calling `fn` for each body. */
function eachLabeled(
  node: unknown,
  basePath: string,
  out: ManifestIssue[],
  fn: (path: string, body: Json, out: ManifestIssue[]) => void,
): void {
  if (node === undefined) return;
  const map = obj(node);
  if (!map) {
    out.push({ path: basePath, message: "expected a labeled block" });
    return;
  }
  for (const [label, val] of Object.entries(map)) {
    const bs = bodies(val);
    if (bs.length === 0) {
      out.push({ path: `${basePath}.${label}`, message: "empty block body" });
    }
    for (const body of bs) fn(`${basePath}.${label}`, body, out);
  }
}

// ── Block validators ─────────────────────────────────────────────────────────

export function validateRaw(root: unknown): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  const r = obj(root);
  if (!r) {
    out.push({ path: "", message: "manifest must be a set of blocks" });
    return out;
  }
  unknownKeys("", r, ["namespace", "gate", "credential", "approver", "serve"], out);
  eachLabeled(r.namespace, "namespace", out, validateNamespace);
  eachLabeled(r.gate, "gate", out, validateGate);
  eachLabeled(r.credential, "credential", out, validateCredential);
  eachLabeled(r.approver, "approver", out, validateApprover);
  eachLabeled(r.serve, "serve", out, validateServe);
  return out;
}

function validateNamespace(path: string, body: Json, out: ManifestIssue[]): void {
  unknownKeys(path, body, ["object"], out);
  eachLabeled(body.object, `${path}.object`, out, validateObject);
}

function validateObject(path: string, body: Json, out: ManifestIssue[]): void {
  unknownKeys(path, body, ["entrypoint", "class", "env", "bindings"], out);
  checkString(path, body, "entrypoint", out, true);
  checkString(path, body, "class", out);
  checkStringMap(path, body, "env", out);
  if ("bindings" in body) {
    for (const b of bodies(body.bindings)) {
      const bp = `${path}.bindings`;
      unknownKeys(bp, b, ["ai", "folder"], out);
      eachLabeled(b.ai, `${bp}.ai`, out, (p, ab) => {
        unknownKeys(p, ab, ["endpoint"], out);
        checkString(p, ab, "endpoint", out, true);
      });
      eachLabeled(b.folder, `${bp}.folder`, out, (p, fb) => {
        unknownKeys(p, fb, ["grant", "mode"], out);
        checkString(p, fb, "grant", out, true);
        checkEnum(p, fb, "mode", ["read-only", "read-write"], out);
      });
    }
  }
}

function validateGate(path: string, body: Json, out: ManifestIssue[]): void {
  unknownKeys(path, body, ["allow", "approve", "approver", "deny_default"], out);
  checkString(path, body, "approver", out);
  checkBool(path, body, "deny_default", out);
  validateAllow(body.allow, `${path}.allow`, out);
  eachLabeled(body.approve, `${path}.approve`, out, (p, ab) => {
    unknownKeys(p, ab, ["hosts", "condition"], out);
    checkStringArray(p, ab, "hosts", out, true);
    checkString(p, ab, "condition", out);
  });
}

/**
 * Validate a gate's `allow` blocks, branching on the block label: `automation` takes
 * shortcuts/scripts (hosts/credential forbidden), everything else is an egress protocol taking
 * hosts/credential (shortcuts/scripts forbidden). unknownKeys enforces the "and vice versa".
 */
function validateAllow(node: unknown, basePath: string, out: ManifestIssue[]): void {
  if (node === undefined) return;
  const map = obj(node);
  if (!map) {
    out.push({ path: basePath, message: "expected a labeled block" });
    return;
  }
  for (const [label, val] of Object.entries(map)) {
    const bs = bodies(val);
    if (bs.length === 0) {
      out.push({ path: `${basePath}.${label}`, message: "empty block body" });
    }
    const p = `${basePath}.${label}`;
    for (const ab of bs) {
      if (label === "automation") {
        unknownKeys(p, ab, ["shortcuts", "scripts", "condition"], out);
        checkStringArray(p, ab, "shortcuts", out);
        checkBool(p, ab, "scripts", out);
        checkString(p, ab, "condition", out);
      } else {
        unknownKeys(p, ab, ["hosts", "condition", "credential"], out);
        checkStringArray(p, ab, "hosts", out, true);
        checkString(p, ab, "condition", out);
        checkString(p, ab, "credential", out);
      }
    }
  }
}

function validateApprover(path: string, body: Json, out: ManifestIssue[]): void {
  unknownKeys(path, body, ["type", "model", "endpoint", "prompt", "allow_when"], out);
  checkEnum(path, body, "type", ["llm_approver", "rule_based"], out);
  checkString(path, body, "model", out);
  checkString(path, body, "endpoint", out);
  checkString(path, body, "prompt", out);
  checkString(path, body, "allow_when", out);
}

function validateCredential(path: string, body: Json, out: ManifestIssue[]): void {
  unknownKeys(path, body, [
    "type",
    "header",
    "prefix",
    "username",
    "placeholder",
    "keychain",
  ], out);
  checkEnum(path, body, "type", ["bearer_token", "header_token", "basic_auth"], out);
  checkString(path, body, "header", out);
  checkString(path, body, "prefix", out);
  checkString(path, body, "username", out);
  checkString(path, body, "placeholder", out, true);
  checkString(path, body, "keychain", out, true);
}

function validateServe(path: string, body: Json, out: ManifestIssue[]): void {
  unknownKeys(path, body, ["tailnet_users", "funnel"], out);
  checkStringArray(path, body, "tailnet_users", out);
  checkBool(path, body, "funnel", out);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** Parse + validate a manifest file; returns issues (empty = valid). */
export async function validateFile(
  hclText: string,
  filename = "resagent.hcl",
): Promise<ManifestIssue[]> {
  return validateRaw((await hclParse(filename, hclText)) as Json);
}

if (import.meta.main) {
  const file = Deno.args[0];
  if (!file) {
    console.error("usage: deno task validate <manifest.hcl>");
    Deno.exit(2);
  }
  const issues = await validateFile(await Deno.readTextFile(file), file);
  if (issues.length === 0) {
    console.log(`${file}: valid`);
  } else {
    console.error(`${file}: ${issues.length} schema error(s)`);
    console.error(formatIssues(issues));
    Deno.exit(1);
  }
}
