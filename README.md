# ResAgent

> [!WARNING]
> ResAgent is experimental software under active development.
> It is an early alpha and is not ready for production use.

ResAgent is a macOS-native Durable Objects runtime.
It runs durable agent processes as a long-lived local service,
with native capabilities, local open-weight models, and audited egress.
The project aims for integration and polish comparable to OrbStack.

## The stack

| Component | Role | Dependency |
| ----------- | ------ | ------------ |
| **Celld** | runtime engine (Workers/DO semantics) | `denoland/celld` |
| **Deno Desktop** | shell: menu bar, inspector, control plane | Deno 2.9+ |
| **Claw Patrol** | egress gate: HCL rules, credential injection | `denoland/clawpatrol` |
| **Tailscale** | reach beyond localhost + identity | `tailscale serve` / LocalAPI |
| **deno-mlx** | `env.AI` local inference backend | `github.com/mattt/deno-mlx` |

A Swift runtime core is being developed in parallel and validated against workerd.
See the corresponding track in the project plan.

## Layout

```
src/ai/                   env.AI: OpenAI HTTP layer (server) + deno-mlx backend + entry (M4, C3)
src/hub/pull.ts           HF Hub model downloads, native TS + Xet-accelerated (M4)
src/manifest/             HCL manifest -> typed model -> wrangler.toml for celld deploy (M2, C4)
src/conformance/          engine-neutral storage/alarm conformance harness vs workerd (H0, C1/C2)
src/lint/                 object-source deny-list lint: standard Workers APIs only (C1)
src/protocol/             control-plane <-> daemon protocol: typed frames + NDJSON codec (C5)
examples/research-agent/  example durable object + its HCL manifest
launchd/                  LaunchAgent plists for the supervised services (celld, minio)
scripts/bootstrap.sh      one-time host setup (fetches celld, mlx-c, minio, a model)
```
