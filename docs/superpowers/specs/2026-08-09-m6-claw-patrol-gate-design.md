# ResAgent M6 — Claw Patrol as the egress gate (design)

*2026-08-09. Phase two, milestone M6.*
*Approved shape: translate-down + gate-neutral (brainstorming, this session).*

## Goal

Every outbound action from a Celld object is judged locally by a Claw Patrol gateway before it
reaches the network. Rules are authored once in ResAgent's HCL (C4) and translated down to Claw
Patrol's native config; credentials live in the macOS Keychain and are injected at the wire, never
held by the object.

**Exit criteria (from the plan, unchanged):** an object makes an outbound call it has no credentials
for → the gate injects them; an identical call to a disallowed host is blocked by rule.
**Artifact:** the "object never held the token" demo + a blocked-egress log line.

## The bet, restated for the gate

M6 applies the project's engine-neutral thesis to the *gate*. Just as C2 has an `Engine` interface
with an in-memory reference + a real workerd/celld measured against it, and C5 has a `DaemonBackend`
with an in-memory backend + a real celld backend, **M6 has a `GateController` interface with an
in-process reference gate + a real Claw Patrol backend measured against it.** The gate's semantics
are defined by a **corpus**, not by reading Claw Patrol's source — and the corpus is checked against
real Claw Patrol as the oracle.

## Real Claw Patrol facts that shape this design (verified against 0.5.8, `b3ffe68`)

Installed and probed this session (`clawpatrol version`, `--help`, live schema fetch). These are
alpha facts — re-verify before relying.

- **CLI:** `clawpatrol gateway <config.hcl>` (run the proxy), `clawpatrol run -- <cmd>` (per-process
  tunnel), `clawpatrol join <url>` (host-wide WireGuard), **`clawpatrol validate <config.hcl>`**
  (parse+compile a config), **`clawpatrol test <config.hcl> <fixture.json|dir>`** (replay action
  fixtures against a policy, report verdict drift; exit 0 match / 1 mismatch / 2 load error).
- **Two oracles fall out of the CLI for free:**
  - `clawpatrol validate` → an oracle for our **translator** (is the emitted config.hcl real?).
  - `clawpatrol test` → an oracle for our **verdict corpus** (does real Claw Patrol produce the
    verdict we expect for a given action?). This is the direct analog of `deno task oracle`
    (workerd) for storage.
- **Config grammar (`schema_version = 1`), bare-name references, flat global namespace:**
  - `gateway { … wireguard { subnet_cidr } / tailscale { … } … }` — operational; needs restart.
  - `endpoint "<type>" "<name>" { … }` — typed target. `https` → `hosts = [..]`; also `postgres`,
    `kubernetes`, `ssh`, `clickhouse_*`.
  - `credential "<type>" "<name>" { … }` — typed secret handle bound to endpoint(s). Types include
    `bearer_token`, `header_token { header, prefix }`, `basic_auth { username }`, `passthrough`.
    The **secret value is provided out of band** (dashboard/state_dir), not in the config file.
  - `rule "<name>" { endpoint = <name> | endpoints = [..]; priority = int; disabled = bool;
    condition = "<CEL>"; credential = <name>; verdict = "allow"|"deny"; reason = "…";
    approve = [<approver>..] }`. Higher `priority` runs first.
  - `approver "llm_approver"|"human_approver" "<name>" { … }`, `policy "<name>"` (reusable LLM
    proctor prompt), `profile "<name>" { credentials = [..] }`, `defaults { … }`, `tunnel …`.
  - CEL facts: HTTP `http.method`/`http.path`/`http.header.*`/`http.body_json.*`; SQL
    `sql.statement`/`sql.tables`; K8s `k8s.verb`/`k8s.resource`/`k8s.namespace`; shared `endpoint`,
    `profile`, `reason`.
- **`clawpatrol test` fixture format** (this *is* our gate corpus case on disk):
  ```json
  { "action": { "host": "api.github.com", "credential": "github_pat", "peer_ip": "…",
                "http": { "method": "DELETE", "path": "/repos/…", "headers": {…} } },
    "match":  { "verdict": "deny", "rule": "github-writes", "endpoint": "https.github",
                "reason": "…" } }
  ```
  `action` carries exactly one facet (`http` | `sql` | `k8s` | `ssh`); `match.verdict` ∈
  `allow | deny | approve | passthrough`; `match.reason` is informational (not compared on replay).
- **The macOS system extension is NOT installed** (`clawpatrol status` → `✗ system extension`,
  `✗ CA bundle`, `✗ wg.conf`; `Clawpatrol.app` present). So **live per-process interception
  (`clawpatrol run`, `join`) cannot run on this Mac yet** — it needs an approved NetworkExtension.
  This bounds M6's *live tunnel* leg but **not** the translator or verdict corpus, which run through
  `validate`/`test` with no tunnel.

## The honest split (what lands vs. what is the spike)

| Part | Backing | CI-able now? |
|------|---------|--------------|
| Gate policy model + reference gate + corpus | in-process | ✅ |
| Translator ResAgent-HCL → clawpatrol config.hcl | `clawpatrol validate` oracle | ✅ |
| Verdict corpus vs. real Claw Patrol | `clawpatrol test` oracle | ✅ (needs the binary; gated like `conformance:celld`) |
| Keychain read + placeholder→secret injection | reference gate (deterministic) | ✅ |
| **Live egress: celld object → gateway → net** | `clawpatrol gateway` + tunnel | ⚠️ **spike** — blocked by the missing system extension; see §Egress |

This mirrors how celld conformance is real-engine-backed yet the full launchd/live story has known
gaps. Most of M6 is genuinely Claw-Patrol-backed and green; only the final live-wire demo hits the
OS entitlement wall, and we say so.

## Architecture

```
resagent.hcl  ──parse──▶  Manifest { deployment, gate: GatePolicy }
   (C4, one grammar)              │                    │
                                  │                    ├─▶ src/gate/clawpatrol_config.ts
                                  │                    │      → config.hcl ──▶ clawpatrol validate  (oracle)
                                  │                    │                        clawpatrol gateway   (live, spike)
                                  ▼                    ▼
                    src/manifest/wrangler.ts     GateController  (interface)
                     → wrangler.toml (celld)      ├─ ReferenceGate  (in-process; CI truth-for-dev)
                                                  └─ ClawPatrolGate (validate + test + live gateway)
                                                          ▲
                       gate corpus (cases) ───────────────┤ diff runner: reference verdict == oracle verdict
                       → clawpatrol fixtures ──────────────┘   (analog of conformance runner)
```

### Components (new `src/gate/`, mirroring `src/conformance/` + `src/manifest/`)

- **`src/gate/policy.ts`** — the compiled, engine-neutral policy: `Policy { endpoints, credentials,
  rules }`, `CompiledRule { name, endpoint, priority, condition?, credential?, verdict, reason }`,
  `Verdict = "allow"|"deny"|"approve"|"passthrough"`, `Endpoint`, `Credential`. No Claw Patrol or
  manifest types leak in.
- **`src/gate/compile.ts`** — `compileGates(Manifest): Policy`: each `gate` target → an `https`
  endpoint per allow-proto/hosts + an allow rule (with credential + optional condition) + a
  `priority=-100` default-deny when `deny_default`. The one place manifest shape meets gate shape.
- **`src/gate/facts.ts`** — `ActionFacts` (the neutral request shape: `host`, `credential?`, `peer_ip?`,
  and one facet `http`/`sql`/`k8s`/`ssh`), matching the fixture `action` vocabulary so a fact set
  serializes straight to a clawpatrol fixture.
- **`src/gate/cel.ts`** — a **bounded CEL-subset evaluator** for the reference gate: string/`==`/`!=`,
  `&&`/`||`/`!`, parenthesization, `.startsWith`/`.contains`/`.matches`, member access over the fact
  namespaces above. Authored conditions are constrained to this subset; the subset maps 1:1 onto
  Claw Patrol's CEL, so the same `condition` string is emitted verbatim into config.hcl. The corpus +
  `clawpatrol test` keep the two evaluators honest — any divergence fails CI.
- **`src/gate/controller.ts`** — the `GateController` interface: `applyPolicy(GatePolicy)`,
  `evaluate(ActionFacts): Promise<VerdictResult>`, `injectCredential(name): Promise<Placeholder→secret>`
  (reference-only shim), `start()/stop()`. The seam every backend implements.
- **`src/gate/reference.ts`** — `ReferenceGate`: pure, deterministic. Sorts rules by priority,
  first-match wins (endpoint match + `cel.ts` condition), applies a default-deny, and models
  placeholder→secret injection with fake secrets. The develop-against substrate; runs with no
  permissions, no binary.
- **`src/gate/clawpatrol_config.ts`** — emits Claw Patrol `config.hcl` from a `GatePolicy`:
  one `endpoint "https" "<n>" { hosts }` per host group, one `credential "<type>" "<n>" {}` per
  declared secret (value NOT written — injected via Keychain into gateway state), one `rule` per
  `GateRule` + a `priority=-100` default-deny, and a minimal `gateway {}` (local `dashboard_listen`,
  `state_dir`). Uses bare-name references. HCL is emitted textually (small, controlled) — the
  `hcl2json` WASM dep is for *reading*, not writing.
- **`src/gate/clawpatrol.ts`** — `ClawPatrolGate` backend: `applyPolicy` writes config.hcl and shells
  `clawpatrol validate` (throws on non-zero); `evaluate` writes a fixture and shells `clawpatrol test`
  to obtain the real verdict; a `startGateway()` (behind an env flag) boots `clawpatrol gateway` for
  the live spike. Subprocess plumbing patterned on `src/conformance/celld.ts`.
- **`src/gate/keychain.ts`** — macOS Keychain wrapper over the `security` CLI
  (`add-generic-password`/`find-generic-password`/`delete-generic-password`) under a narrow service
  scope `resagent.gate.<name>`. Read-only at evaluate time; write helpers for demo setup. Never logs
  secret values.
- **`src/gate/corpus.ts`** — the gate conformance corpus: an array of `{ name, facts, expect }` cases
  spanning allow/deny (host allowlist, method/path conditions, header conditions, credential-gated),
  plus a `toFixture()` that serializes a case to the clawpatrol fixture JSON.
- **`src/gate/runner.ts`** — the diff runner: run each case through a `GateController`, compare to
  `expect`, report first divergence with expected/actual (mirrors `src/conformance/runner.ts`).

### C4 extension (`src/manifest`) — extend the existing grammar, don't reinvent it

**Already present** (discovered this session): the manifest grammar parses and strictly validates
`gate "<target>" { allow "<proto>" { hosts=[…] } approver=… deny_default=bool }` into
`Manifest.gates: GateRule[]` (`src/manifest/{types,parse,validate}.ts`), and the example
`resagent.hcl` already carries a `gate "research/ResearchAgent"` stanza. So M6 **extends** it minimally:

- **`types.ts`** — add `Credential` (name, type, header?, prefix?, username?, placeholder, keychain)
  and `Manifest.credentials: Credential[]`; add optional `condition?` and `credential?` to `AllowRule`.
- **`parse.ts`** — parse a top-level `credential "<name>" { type header prefix keychain placeholder }`
  block and the two new `allow` fields.
- **`validate.ts`** — add `validateCredential` (key allow-list + `type` enum
  `bearer_token|header_token|basic_auth`) and widen the `allow` allow-list with `condition`/`credential`
  (and register `credential` at the root allow-list).
- **`examples/research-agent/resagent.hcl`** — add a `credential "hf"` block, bind it on the allow
  rule, and add one `condition` (e.g. `http.method == "GET"`) to exercise the CEL path.

`src/gate` **consumes** this typed model (`compile.ts`: `Manifest → Policy`) rather than re-parsing —
one grammar, one parser, as C4 requires.

### C5 extension (`src/protocol`, `src/shell`)

- `src/protocol/messages.ts` gains read-only `gate-rules` (the compiled policy as typed resources)
  and `gate-log` (recent verdicts / blocked-egress lines) methods. `memory_backend.ts` serves them
  from an injected `GateController`; the daemon/celld backends forward.
- `src/shell/inspector.html` gains a **typed gate view** (rules in the ResEdit idiom) and surfaces
  **blocked-egress lines** in the log tab. Read-only this pass (the Phase-two inspector note calls
  for "typed views for gate rules").

## Egress interception — the spike (open question #7, resolved-by-doing)

Recommended mechanism, in preference order:

1. **`clawpatrol run -- <celld-node-cmd>`** — wrap the celld node's process tree; only its egress is
   tunneled to a local `clawpatrol gateway`. Zero object-code change → preserves C1. **Requires the
   macOS NetworkExtension system extension**, which is not installed → this is the blocked leg.
2. **Local `clawpatrol gateway` + `clawpatrol join --whole-machine`** — host-wide WireGuard. Coarser
   (gates the whole Mac) and also needs the tunnel stack. Fallback only.
3. **Proxy-env** — if the celld node honors `HTTPS_PROXY`, point it at a local CONNECT endpoint the
   gateway exposes. Uncertain that clawpatrol exposes a plain CONNECT proxy (its transport is
   WG/Tailscale); to be probed during the spike.

The transport is modeled as a pluggable detail; **M6 does not block on the live tunnel.** The verdict
+ translator legs are proven via `validate`/`test`.

**Spike result (verified this session, clawpatrol 0.5.8):**
- ✅ **A local `clawpatrol gateway` boots with our translated config** — it applied its migrations,
  loaded `policy: 1 endpoints across 0 profiles`, brought up the WireGuard promiscuous forwarder, and
  listened on `127.0.0.1:8443`, staying up. The gateway + ResAgent-derived policy are real and live.
- ✅ Verdicts proven equivalent to real Claw Patrol via `clawpatrol test` (6/6).
- ⚠️ **The client tunnel is the blocker.** `clawpatrol run` needs `~/.config/clawpatrol/wg.conf` from
  `clawpatrol join`, which onboards via a WireGuard device flow requiring the **macOS NetworkExtension
  system extension** (`clawpatrol status` → `✗ system extension`). Approving it is a GUI action in
  System Settings needing admin — a **user action** (and "modifying system/security settings" is
  off-limits to the agent). This is the documented true-technical-blocker; approving the extension
  unblocks the live `clawpatrol run` demo. Everything up to it is done and verified.

## Keychain credential-injection flow

1. Demo setup writes a real token to Keychain: `security add-generic-password -s resagent.gate.github
   -a resagent -w <token>` (done by a setup script / `keychain.ts` helper, not committed).
2. `resagent.hcl` declares `credential "github" { type = "header_token" header = "Authorization"
   prefix = "Bearer " placeholder = "RESAGENT_GH" }` and a rule binding it to the endpoint.
3. Translate emits a `credential "header_token" "github" { header = "Authorization" prefix = "Bearer " }`
   (no value) into config.hcl; the value is loaded from Keychain into the gateway's credential store
   at policy-apply time (live: via clawpatrol's state; reference: held in-memory).
4. The object sends the **placeholder**; the gate swaps in the real secret at the wire. The object
   bundle and logs never contain the token. The reference gate demonstrates this deterministically;
   real Claw Patrol does it natively.

## CEL-subset condition grammar (bounded, oracle-checked)

Supported in authored `condition` strings (and in `cel.ts`): string literals, `==` `!=`, `&&` `||`
`!`, parentheses, and the method calls `.startsWith(x)` `.contains(x)` `.matches(x)` over
`http.method` `http.path` `http.header.<k>` `http.body_json.<k>` `sql.statement` `sql.tables`
`k8s.verb` `k8s.resource` `k8s.namespace`. Anything outside the subset is a validation error (so we
never emit a condition the reference gate can't also evaluate). Divergence between `cel.ts` and Claw
Patrol on any corpus case fails `deno task gate:clawpatrol`.

## Testing & CI

- `src/gate/*_test.ts` — unit tests: `cel.ts` (truth tables), `reference.ts` (priority/first-match/
  default-deny/credential-gating), `clawpatrol_config.ts` (golden config.hcl), `keychain.ts` (against
  a fake `security` or a scoped real entry), `runner.ts` (catches an injected divergence).
- New tasks (deno.json): `gate:validate` (translate example → `clawpatrol validate`),
  `gate:translate` (emit config.hcl), `gate:reference` (corpus on the reference gate),
  `gate:clawpatrol` (corpus → fixtures → `clawpatrol test`, the oracle; needs the binary).
- **CI** ([.github/workflows/ci.yml](../../../.github/workflows/ci.yml)) runs the reference corpus +
  translate + `clawpatrol validate` (binary is small to fetch or the step is gated like the celld
  job). `gate:clawpatrol` full replay runs where the binary is available, matching the existing
  `conformance:celld` posture. A new contract row **C6 is *not* added** — the gate rides C4 (config)
  + C5 (protocol); the board stays five contracts.

## Demo path → exit criteria

```bash
# setup (once): put a real token in Keychain under resagent.gate.github
# 1. translate + validate the policy against real Claw Patrol
deno task gate:translate examples/research-agent/resagent.hcl   # → config.hcl
deno task gate:validate  examples/research-agent/resagent.hcl   # clawpatrol validate: OK
# 2. prove verdicts match real Claw Patrol
deno task gate:clawpatrol                                       # corpus vs clawpatrol test: N/N
# 3. reference-gate demo of the two exit conditions (deterministic, always runs)
deno task gate:demo
#    → object calls allowed host with only a placeholder  → gate injects secret (object never held it)
#    → identical call to a disallowed host                → deny + a blocked-egress log line
# 4. live spike (best-effort): clawpatrol run -- <celld node>, if the system extension is approvable
```

- *"an outbound call it has no credentials for → gate injects them"* → step 3a + the Keychain flow.
- *"an identical call to a disallowed host is blocked by rule"* → step 3b (deny + log line).
- Both verdicts are additionally confirmed against **real Claw Patrol** in step 2.

## Out of scope (hooks noted, not built in M6)

- **M7** — `approver "llm_approver"` verdict chains (the local judge). The schema hook exists; M6
  emits no approvers, verdicts are allow/deny only.
- **M8** — identity-header rules / Tailscale serve. `gate` blocks add no `identity` sub-block yet.
- **M10** — folder grants (`grant` blocks, security-scoped bookmarks).
- Non-HTTP wire parsing (SQL/K8s facts) is modeled in `facts.ts`/`corpus.ts` for fidelity to the
  fixture format, but the demo and rules target HTTP egress.

## Risks

| Risk | Mitigation |
|------|------------|
| System extension not installed → no live tunnel | Translator + verdict corpus are `validate`/`test`-backed and need no tunnel; live leg is an explicit best-effort spike, blocker recorded honestly |
| Our CEL subset diverges from Claw Patrol's CEL | Bounded subset + `clawpatrol test` oracle on every corpus case; out-of-subset conditions are validation errors |
| Claw Patrol 0.5.8 is fast-moving alpha | Pin behavior in the corpus; re-verify schema before relying; version recorded here (`b3ffe68`) |
| Keychain secret leakage | Narrow `resagent.gate.*` service scope; values never written to config.hcl, logs, or the object bundle |
| Emitting HCL by hand drifts from grammar | Every emitted config is run through `clawpatrol validate` in CI |
