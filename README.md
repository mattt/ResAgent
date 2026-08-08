# ResAgent

A macOS-native Durable Objects runtime — durable agent processes with native capabilities,
local open-weights models, and audited egress, running as a long-lived local service with
OrbStack-grade polish.

## The stack

| Leg | Role | Dependency |
|-----|------|-----------|
| **Celld** | runtime engine (Workers/DO semantics) | `denoland/celld` |
| **Deno Desktop** | shell: menu bar, inspector, control plane | Deno 2.9+ |
| **Claw Patrol** | egress gate: HCL rules, credential injection | `denoland/clawpatrol` |
| **Tailscale** | reach beyond localhost + identity | `tailscale serve` / LocalAPI |
| **deno-mlx** | `env.AI` local inference backend | `github.com/mattt/deno-mlx` |

The Swift hedge (a native runtime core validated against workerd) develops in parallel — see the
plan's hedge track.

## Layout

```
src/ai/                   env.AI: OpenAI HTTP layer (server) + deno-mlx backend + entry (M4, C3)
src/hub/pull.ts           HF Hub model downloads, native TS + Xet-accelerated (M4)
src/manifest/             HCL manifest → typed model → wrangler.toml for celld deploy (M2, C4)
src/conformance/          engine-neutral storage/alarm conformance harness vs workerd (H0, C1/C2)
src/lint/                 object-source deny-list lint: standard Workers APIs only (C1)
examples/research-agent/  the flagship durable object + its HCL manifest
launchd/                  LaunchAgent plists for the supervised services (celld, minio)
scripts/bootstrap.sh      one-time host setup (fetches celld, mlx-c, minio, a model)
```

## Status

Phase one, in progress. `env.AI` (M4) runs today against deno-mlx once the host is
bootstrapped; the Celld + object-store legs (M1) come up via launchd after `scripts/bootstrap.sh`.

Requires an **Apple Silicon** Mac (Celld and deno-mlx are ARM64-only) and Deno 2.x.
