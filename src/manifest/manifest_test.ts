/**
 * Contract test for C4: the HCL manifest parses and lowers to a valid wrangler.toml.
 *
 * Parses the real example manifest, checks the typed model, then translates and round-trips the
 * emitted TOML (parse it back) to verify the wrangler structure — and that ResAgent-level blocks
 * (ai/folder/gate/serve) are deliberately absent from the deploy output.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import { parse as parseToml } from "@std/toml";
import { parseManifest } from "./parse.ts";
import { toWrangler } from "./wrangler.ts";
import { ManifestError, validateFile } from "./validate.ts";
import type { Manifest } from "./types.ts";

const exampleUrl = new URL("../../examples/research-agent/resagent.hcl", import.meta.url);
const example = await Deno.readTextFile(exampleUrl);

Deno.test("parses the manifest into the typed model", async () => {
  const m = await parseManifest(example);

  assertEquals(m.namespaces.length, 1);
  const ns = m.namespaces[0];
  assertEquals(ns.name, "research");
  assertEquals(ns.objects.length, 1);

  const o = ns.objects[0];
  assertEquals(o.name, "ResearchAgent");
  assertEquals(o.entrypoint, "index.ts");
  assertEquals(o.className, "ResearchAgent");
  assertEquals(o.env.MODEL, "HuggingFaceTB/SmolLM2-360M-Instruct");
  assertEquals(o.env.INTERVAL_MS, "3600000");
  assertEquals(o.ai[0].endpoint, "http://127.0.0.1:8788");
  assertEquals(o.folders[0].grant, "~/ResAgent/research");
  assertEquals(o.folders[0].mode, "read-write");

  // Non-deploy blocks parse too (one grammar, C4).
  assertEquals(m.gates[0].target, "research/ResearchAgent");
  assertEquals(m.gates[0].denyDefault, true);
  assertEquals(m.gates[0].approver, "local-judge");
  assert(m.gates[0].allow[0].hosts.includes("huggingface.co"));
  assertEquals(m.serves[0].pattern, "research/*");
  assertEquals(m.serves[0].funnel, false);
  assert(m.serves[0].tailnetUsers.includes("mattt@"));

  // Gate allow rules carry the optional condition + credential (C4 → M6).
  assertEquals(m.gates[0].allow[0].condition, 'http.method == "GET"');
  assertEquals(m.gates[0].allow[0].credential, "hf");

  // The credential block parses; the real secret lives in Keychain, not here.
  assertEquals(m.credentials.length, 1);
  const cred = m.credentials[0];
  assertEquals(cred.name, "hf");
  assertEquals(cred.type, "header_token");
  assertEquals(cred.header, "Authorization");
  assertEquals(cred.prefix, "Bearer ");
  assertEquals(cred.placeholder, "RESAGENT_HF_TOKEN");
  assertEquals(cred.keychain, "resagent.gate.hf");
});

Deno.test("rejects a credential with an unknown type and a missing keychain", async () => {
  const issues = await validateFile(`
    credential "bad" {
      type        = "sorcery"
      placeholder = "X"
    }
  `);
  assert(
    issues.some((i) => i.path === "credential.bad.type" && i.message.includes("one of")),
  );
  assert(
    issues.some((i) => i.path === "credential.bad.keychain" && i.message === "required"),
  );
});

Deno.test("lowers to a valid wrangler.toml (round-tripped)", async () => {
  const m = await parseManifest(example);
  const { toml, warnings } = toWrangler(m);

  const w = parseToml(toml) as Record<string, unknown>;
  assertEquals(w.name, "research");
  assertEquals(w.main, "index.ts");
  assert(typeof w.compatibility_date === "string");

  const dobj = w.durable_objects as { bindings: { name: string; class_name: string }[] };
  assertEquals(dobj.bindings[0].name, "ResearchAgent");
  assertEquals(dobj.bindings[0].class_name, "ResearchAgent");

  const migrations = w.migrations as { tag: string; new_sqlite_classes: string[] }[];
  assert(migrations[0].new_sqlite_classes.includes("ResearchAgent"));

  const vars = w.vars as Record<string, string>;
  assertEquals(vars.MODEL, "HuggingFaceTB/SmolLM2-360M-Instruct");

  // ResAgent-level blocks must NOT leak into the deploy output.
  assertEquals(w.gate, undefined);
  assertEquals(w.serve, undefined);
  assert(!("ai" in w));

  // The dropped ai/folder bindings are surfaced, not silent.
  assert(warnings.some((x) => x.includes("ai/folder")));
});

Deno.test("rejects a namespace whose objects disagree on entrypoint", () => {
  const m: Manifest = {
    namespaces: [{
      name: "n",
      objects: [
        { name: "A", entrypoint: "a.ts", className: "A", env: {}, ai: [], folders: [] },
        { name: "B", entrypoint: "b.ts", className: "B", env: {}, ai: [], folders: [] },
      ],
    }],
    gates: [],
    credentials: [],
    approvers: [],
    serves: [],
  };
  assertThrows(() => toWrangler(m), Error, "share one entrypoint");
});

Deno.test("rejects an unknown namespace name", async () => {
  const m = await parseManifest(example);
  assertThrows(() => toWrangler(m, "nope"), Error, 'no namespace "nope"');
});

Deno.test("parseManifest rejects malformed HCL", async () => {
  await assertRejects(() => parseManifest("namespace {", { filename: "bad.hcl" }));
});

// ── strict schema validation (C4) ──────────────────────────────────────────

Deno.test("the example manifest validates cleanly", async () => {
  assertEquals(await validateFile(example), []);
});

Deno.test("rejects an unknown key with a precise path", async () => {
  const issues = await validateFile(`
    namespace "n" {
      object "O" {
        entrypoint = "o.ts"
        colour     = "blue"
      }
    }
  `);
  assert(
    issues.some((i) =>
      i.path === "namespace.n.object.O.colour" && i.message.includes("unknown")
    ),
  );
});

Deno.test("rejects an unknown top-level block", async () => {
  const issues = await validateFile(`widget "x" {}`);
  assert(issues.some((i) => i.message.includes(`unknown key "widget"`)));
});

Deno.test("rejects a missing required entrypoint", async () => {
  const issues = await validateFile(`
    namespace "n" {
      object "O" {
        class = "O"
      }
    }
  `);
  assert(
    issues.some((i) =>
      i.path === "namespace.n.object.O.entrypoint" && i.message === "required"
    ),
  );
});

Deno.test("rejects an invalid folder mode and a non-string host list", async () => {
  const issues = await validateFile(`
    namespace "n" {
      object "O" {
        entrypoint = "o.ts"
        bindings {
          folder "F" {
            grant = "~/x"
            mode  = "sideways"
          }
        }
      }
    }
    gate "n/O" {
      allow "https" {
        hosts = "not-a-list"
      }
    }
  `);
  assert(issues.some((i) => i.path.endsWith(".mode") && i.message.includes("one of")));
  assert(
    issues.some((i) =>
      i.path.endsWith(".hosts") && i.message.includes("array of strings")
    ),
  );
});

Deno.test("parseManifest is strict by default and lenient on request", async () => {
  const bad = `
    namespace "n" {
      object "O" {
        entrypoint = "o.ts"
        nope = true
      }
    }
  `;
  await assertRejects(() => parseManifest(bad), ManifestError, "schema error");
  // strict:false still builds a model, ignoring the unknown key.
  const m = await parseManifest(bad, { strict: false });
  assertEquals(m.namespaces[0].objects[0].name, "O");
});
