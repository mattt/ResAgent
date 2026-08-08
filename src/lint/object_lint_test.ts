/**
 * Tests for the object-source lint (contract C1).
 *
 * Confirms the flagship object is clean, that each banned construct is flagged on the right line,
 * and that lookalikes (property accesses, substrings, mentions inside strings/comments) are not.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { lintObjectFiles, lintObjectSource } from "./object_lint.ts";

Deno.test("clean standard-Workers object passes", () => {
  const src = `
    export class Agent {
      constructor(ctx) { this.ctx = ctx; }
      async fetch(req) {
        const url = new URL(req.url);
        await this.ctx.storage.put("k", 1);
        return Response.json({ ok: true });
      }
    }
  `;
  assertEquals(lintObjectSource(src), []);
});

Deno.test("flags Node globals and Deno usage", () => {
  const issues = lintObjectSource(
    [
      `const p = process.env.X;`, // line 1
      `const b = Buffer.from("x");`, // line 2
      `const d = Deno.cwd();`, // line 3
    ].join("\n"),
    "obj.ts",
  );
  const byLine = new Map(issues.map((i) => [i.line, i.message]));
  assert(byLine.get(1)?.includes("process"));
  assert(byLine.get(2)?.includes("Buffer"));
  assert(byLine.get(3)?.includes("Deno"));
});

Deno.test("flags CommonJS require and non-portable imports", () => {
  const issues = lintObjectSource(
    [
      `const fs = require("fs");`, // require
      `import { x } from "node:fs";`, // node:
      `import y from "npm:left-pad";`, // npm:
    ].join("\n"),
    "obj.ts",
  );
  assert(issues.some((i) => i.message.includes("require")));
  assert(issues.some((i) => i.message.includes("node:")));
  assert(issues.some((i) => i.message.includes("npm:")));
});

Deno.test("does not flag lookalikes: property access, substrings, strings, comments", () => {
  const src = [
    `foo.process();`, // property access — allowed
    `const x = processData();`, // `process`/`require` as a substring of a longer ident — allowed
    `const msg = "process and Buffer are node globals";`, // inside a string — allowed
    `// process, Buffer, require — mentioned in a comment`, // inside a comment — allowed
    `const g = globalThis.crypto;`, // globalThis is standard (not the \`global\` global) — allowed
  ].join("\n");
  assertEquals(lintObjectSource(src), []);
});

Deno.test("the flagship object passes the lint", async () => {
  const issues = await lintObjectFiles(["examples"]);
  if (issues.length > 0) console.error(issues);
  assertEquals(issues, []);
});
