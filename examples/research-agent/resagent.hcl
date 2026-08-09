# ResAgent manifest (contract C4) — one HCL grammar for the whole product.
#
# This declares the deployment AND the gate rules, folder grants, and tailnet identity policy.
# The control plane translates the `namespace`/`object` blocks into the engine's native deploy
# format at deploy time; the rest configures Claw Patrol and Tailscale. Phase-two blocks are
# present now to show the single-grammar vision, even though their runtimes land later.

namespace "research" {
  # One deployment, many DO classes (Celld runs one application deployment per fleet).
  object "ResearchAgent" {
    entrypoint = "index.ts"
    class      = "ResearchAgent"

    env = {
      TOPIC       = "on-device open-weights inference"
      MODEL       = "HuggingFaceTB/SmolLM2-360M-Instruct"
      INTERVAL_MS = "3600000" # hourly
    }

    bindings {
      # env.AI → the local OpenAI-compatible adapter over deno-mlx (contract C3).
      ai "AI" {
        endpoint = "http://127.0.0.1:8788"
      }

      # phase two — a folder the object may write findings into (security-scoped bookmark).
      folder "FINDINGS" {
        grant = "~/ResAgent/research"
        mode  = "read-write"
      }
    }
  }
}

# ── Egress gate (Claw Patrol) — phase two ──────────────────────────────────────
# "This object may reach these hosts" is a rule, not a default. Credentials are injected at the
# wire from Keychain; the object never holds them.
gate "research/ResearchAgent" {
  allow "https" {
    hosts = ["huggingface.co", "*.hf.co"]
    # Only read traffic to the Hub, and inject the Hub token at the wire (from Keychain).
    condition  = "http.method == \"GET\""
    credential = "hf"
  }
  # Borderline requests escalate to the on-device open-weights judge (spec 3).
  approver = "local-judge"
  deny_default = true
}

# The Hub token the gate injects. The object sends the placeholder; the gate swaps in the real
# secret read from the macOS Keychain service below. The value is never in this file or the object.
credential "hf" {
  type        = "header_token"
  header      = "Authorization"
  prefix      = "Bearer "
  placeholder = "RESAGENT_HF_TOKEN"
  keychain    = "resagent.gate.hf"
}

# ── Tailnet identity (Tailscale serve) — phase two ─────────────────────────────
# Addressable across the tailnet; access gated by authenticated identity headers.
serve "research/*" {
  tailnet_users = ["mattt@"]
  funnel        = false # public exposure stays off, per-route consent required
}
