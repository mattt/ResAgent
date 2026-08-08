/**
 * Object-source lint (contract C1): object code targets standard Workers/DO APIs only.
 *
 * A deny-list pass over Durable Object source — no Node globals, no `Deno.*`, no CommonJS, no
 * non-portable import specifiers. This is C1's static leg; the conformance harness is its behavioral
 * leg. Together they keep an object runnable unchanged on Celld, workerd, or the Swift core.
 *
 * Heuristic, not a full type-checker: source is scanned after stripping comments and string/template
 * literals, so identifiers inside strings or `${…}` interpolations are not flagged (a false-negative
 * we accept — better than false-positives on object code that merely mentions a word).
 *
 *   deno task lint:objects [paths...]   (defaults to examples/)
 */

export interface LintIssue {
  file: string;
  line: number;
  message: string;
}

const BANNED_GLOBALS: Record<string, string> = {
  process: "Node global `process` is unavailable in the Workers runtime",
  Buffer: "Node global `Buffer` is unavailable; use Uint8Array / TextEncoder",
  global: "Node global `global` is unavailable; use `globalThis`",
  __dirname: "`__dirname` is unavailable in the Workers runtime",
  __filename: "`__filename` is unavailable in the Workers runtime",
  require: "CommonJS `require` is unavailable; use ES imports",
  Deno: "`Deno.*` APIs are unavailable in object code; use standard Workers APIs",
};

const BANNED_IMPORT_PREFIXES = ["node:", "npm:", "jsr:", "http://", "https://", "file:"];

/** Replace comment and string/template contents with spaces, preserving newlines for line numbers. */
function stripStringsAndComments(src: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") mode = "line", out += "  ", i += 2;
      else if (c === "/" && d === "*") mode = "block", out += "  ", i += 2;
      else if (c === "'") mode = "sq", out += " ", i += 1;
      else if (c === '"') mode = "dq", out += " ", i += 1;
      else if (c === "`") mode = "tpl", out += " ", i += 1;
      else out += c, i += 1;
    } else if (mode === "line") {
      if (c === "\n") mode = "code", out += "\n", i += 1;
      else out += c === "\t" ? "\t" : " ", i += 1;
    } else if (mode === "block") {
      if (c === "*" && d === "/") mode = "code", out += "  ", i += 2;
      else out += c === "\n" ? "\n" : " ", i += 1;
    } else {
      const quote = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
      if (c === "\\") out += "  ", i += 2;
      else if (c === quote) mode = "code", out += " ", i += 1;
      else out += c === "\n" ? "\n" : " ", i += 1;
    }
  }
  return out;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/** Lint one object-source string; returns issues (empty = clean). */
export function lintObjectSource(source: string, file = "<source>"): LintIssue[] {
  const issues: LintIssue[] = [];

  // Import specifiers must be read from the ORIGINAL source (they live in strings).
  const importRe =
    /\b(?:import|export)\b[^;`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
  for (let m = importRe.exec(source); m; m = importRe.exec(source)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const bad = BANNED_IMPORT_PREFIXES.find((p) => spec.startsWith(p));
    if (bad) {
      issues.push({
        file,
        line: lineOf(source, m.index),
        message: `non-portable import specifier "${spec}" (${bad}…)`,
      });
    }
  }

  // Banned identifiers are scanned on stripped source (ignore comments/strings), skipping property
  // accesses like `foo.process`.
  const stripped = stripStringsAndComments(source);
  const globalRe = new RegExp(`\\b(${Object.keys(BANNED_GLOBALS).join("|")})\\b`, "g");
  for (let m = globalRe.exec(stripped); m; m = globalRe.exec(stripped)) {
    if (stripped[m.index - 1] === ".") continue; // property access, not the global
    issues.push({ file, line: lineOf(stripped, m.index), message: BANNED_GLOBALS[m[1]] });
  }

  return issues;
}

async function tsFilesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (/\.(ts|js)$/.test(entry.name) && !/_test\.(ts|js)$/.test(entry.name)) {
        out.push(path);
      }
    }
  };
  const info = await Deno.stat(root);
  if (info.isDirectory) await walk(root);
  else out.push(root);
  return out;
}

/** Lint every object-source file under the given paths. */
export async function lintObjectFiles(paths: string[]): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  for (const p of paths) {
    for (const file of await tsFilesUnder(p)) {
      issues.push(...lintObjectSource(await Deno.readTextFile(file), file));
    }
  }
  return issues;
}

if (import.meta.main) {
  const paths = Deno.args.length > 0 ? Deno.args : ["examples"];
  const issues = await lintObjectFiles(paths);
  if (issues.length === 0) {
    console.log(`object-lint: clean (${paths.join(", ")})`);
  } else {
    for (const i of issues) console.error(`${i.file}:${i.line}: ${i.message}`);
    console.error(`object-lint: ${issues.length} issue(s)`);
    Deno.exit(1);
  }
}
