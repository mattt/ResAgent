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
  # Mac automation the object may drive (M9): a named Shortcut and osascript, nothing else.
  # Automation runs through the same gate as egress — the host is an `automation:*` convention.
  allow "automation" {
    scripts   = true
    shortcuts = ["Daily Digest"]
  }

  # Borderline requests (a Hub write) escalate to the on-device open-weights judge (spec 3)
  # instead of a hard deny — the approver resolves the verdict chain (M7).
  approve "https" {
    hosts     = ["huggingface.co", "*.hf.co"]
    condition = "http.method == \"POST\""
  }
  approver     = "local-judge"
  deny_default = true
}

# The on-device judge the gate escalates to (M7). An OpenAI-compatible endpoint (contract C3) —
# the same local env.AI adapter the object uses — so borderline egress is adjudicated on-device.
approver "local-judge" {
  type     = "llm_approver"
  endpoint = "http://127.0.0.1:8788"
  model    = "HuggingFaceTB/SmolLM2-360M-Instruct"
  prompt   = "You are an egress reviewer for a research agent. Reply ALLOW or DENY with a one-line rationale; deny anything that writes data off-device."
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
