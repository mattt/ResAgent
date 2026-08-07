#!/bin/bash
# One-time host setup for ResAgent phase one (M1). Idempotent; safe to re-run.
#
# This is the step that touches the network and installs system software — run it yourself and
# read it first. It: installs deps (mlx-c, minio, celld), generates object-store credentials into
# Keychain, creates local state dirs, and installs + loads the LaunchAgents.
#
# Requires: Apple Silicon, Homebrew, Deno 2.x. Usage: scripts/bootstrap.sh
set -euo pipefail

RESAGENT_HOME="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
DEFAULT_MODEL="HuggingFaceTB/SmolLM2-360M-Instruct"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# ── 0. Preconditions ──────────────────────────────────────────────────────────
[ "$(uname -m)" = "arm64" ] || { echo "ResAgent requires Apple Silicon (arm64)."; exit 1; }
command -v brew >/dev/null || { echo "Homebrew required: https://brew.sh"; exit 1; }
command -v deno >/dev/null || { echo "Deno 2.x required: https://deno.com"; exit 1; }

# ── 1. Dependencies (NETWORK INSTALLS) ────────────────────────────────────────
log "Installing mlx-c, minio, and the minio client via Homebrew"
brew install mlx-c minio/stable/minio minio/stable/mc || true

# Celld installer (confirmed via celld.dev/docs): installs to ~/.local/bin. Pin with CELLD_VERSION.
if [ ! -x "$HOME/.local/bin/celld" ]; then
  log "Installing celld into ~/.local/bin"
  curl -fsSL https://celld.dev/install.sh | sh
fi

# ── 2. State directories ──────────────────────────────────────────────────────
log "Creating local state directories under $RESAGENT_HOME/{run,data}"
mkdir -p "$RESAGENT_HOME/run/logs" "$RESAGENT_HOME/data/minio"

# ── 3. Object-store credentials → Keychain (narrow scope, never on disk) ───────
if ! security find-generic-password -s dev.resagent.minio -a access-key >/dev/null 2>&1; then
  log "Generating MinIO credentials into Keychain (service dev.resagent.minio)"
  ACCESS_KEY="resagent-$(openssl rand -hex 4)"
  SECRET_KEY="$(openssl rand -base64 24)"
  security add-generic-password -s dev.resagent.minio -a access-key -w "$ACCESS_KEY"
  security add-generic-password -s dev.resagent.minio -a secret-key -w "$SECRET_KEY"
fi

# ── 4. A first model for env.AI (native TS, Xet-accelerated — no Python) ───────
log "Fetching default model via @huggingface/hub (Xet): $DEFAULT_MODEL"
( cd "$RESAGENT_HOME" && deno task pull "$DEFAULT_MODEL" ) || true

# ── 5. Install + (re)load the LaunchAgents ────────────────────────────────────
mkdir -p "$LAUNCH_AGENTS"
chmod +x "$RESAGENT_HOME"/scripts/run-*.sh
for label in dev.resagent.minio dev.resagent.celld; do
  log "Installing LaunchAgent $label"
  sed "s#__RESAGENT_HOME__#$RESAGENT_HOME#g" \
    "$RESAGENT_HOME/launchd/$label.plist" > "$LAUNCH_AGENTS/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/$label.plist"
done

# ── 6. Provision the bucket (celld does NOT auto-create it) ────────────────────
log "Waiting for MinIO, then creating bucket 'resagent'"
AK="$(security find-generic-password -s dev.resagent.minio -a access-key -w)"
SK="$(security find-generic-password -s dev.resagent.minio -a secret-key -w)"
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1 && break; sleep 1
done
mc alias set resagent-local http://127.0.0.1:9000 "$AK" "$SK" >/dev/null
mc mb --ignore-existing resagent-local/resagent

log "Done. Check status: launchctl list | grep resagent"
log "Logs: tail -f $RESAGENT_HOME/run/logs/*.log"
log "Deploy an object: celld deploy examples/research-agent  (reads a translated wrangler.toml)"
