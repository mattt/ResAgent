import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { toClawPatrolConfig } from "./clawpatrol_config.ts";
import type { Policy } from "./policy.ts";

const policy: Policy = {
  endpoints: [{ name: "hf", type: "https", hosts: ["huggingface.co", "*.hf.co"] }],
  credentials: [{
    name: "hf",
    type: "header_token",
    header: "Authorization",
    prefix: "Bearer ",
    placeholder: "RESAGENT_HF_TOKEN",
    keychain: "resagent.gate.hf",
  }],
  rules: [
    {
      name: "hf-allow",
      endpoint: "hf",
      priority: 0,
      condition: 'http.method == "GET"',
      credential: "hf",
      verdict: "allow",
      reason: "read-only Hub",
    },
    {
      name: "hf-deny",
      endpoint: "hf",
      priority: -100,
      verdict: "deny",
      reason: "default deny",
    },
  ],
};

Deno.test("clawpatrol_config: golden output", () => {
  const cfg = toClawPatrolConfig(policy, {
    stateDir: "/tmp/s",
    dashboardListen: "127.0.0.1:8080",
  });
  assertEquals(
    cfg,
    `schema_version = 1

gateway {
  dashboard_listen = "127.0.0.1:8080"
  state_dir = "/tmp/s"
}

endpoint "https" "hf" {
  hosts = ["huggingface.co", "*.hf.co"]
}

credential "header_token" "hf" {
  header = "Authorization"
  prefix = "Bearer "
  endpoint = https.hf
}

rule "hf-allow" {
  endpoint = https.hf
  condition = "http.method == \\"GET\\""
  verdict = "allow"
  reason = "read-only Hub"
}

rule "hf-deny" {
  endpoint = https.hf
  priority = -100
  verdict = "deny"
  reason = "default deny"
}
`,
  );
});

Deno.test("clawpatrol_config: the condition is HCL-escaped so CEL sees real quotes", () => {
  const cfg = toClawPatrolConfig(policy);
  assertStringIncludes(cfg, `condition = "http.method == \\"GET\\""`);
});

Deno.test("clawpatrol_config: credentials can be omitted for pure verdict replay", () => {
  const cfg = toClawPatrolConfig(policy, { includeCredentials: false });
  assertEquals(cfg.includes("credential "), false);
});
