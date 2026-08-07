/**
 * Shared helpers for navigating hcl2json output.
 *
 * hcl2json nests labeled blocks (`namespace "research" {}` → `{namespace: {research: [body]}}`)
 * and wraps every block body in an array (repeated blocks are allowed). Attributes are plain
 * values. These helpers make that shape safe to walk from both parse.ts and validate.ts.
 */

export type Json = Record<string, unknown>;

/** A non-null, non-array object, or undefined. */
export function obj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
}

/** Normalize a block value to its list of bodies (hcl2json wraps bodies in arrays). */
export function bodies(v: unknown): Json[] {
  if (Array.isArray(v)) return v.map(obj).filter((x): x is Json => x !== undefined);
  const o = obj(v);
  return o ? [o] : [];
}

export function str(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : v == null ? dflt : String(v);
}

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)) : [];
}
