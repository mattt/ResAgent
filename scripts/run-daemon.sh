#!/bin/bash
# Wrapper launched by dev.resagent.daemon.plist.
# Runs the ResAgent daemon (contract C5) over a Unix socket, backed by a real celld.
set -euo pipefail

RESAGENT_HOME="$(cd "$(dirname "$0")/.." && pwd)"

# launchd starts agents with a minimal PATH (no user shell profile), so `deno` off Homebrew isn't
# on it — resolve the binary explicitly, honoring an override, then the usual install locations.
DENO_BIN="${DENO_BIN:-}"
if [ -z "$DENO_BIN" ]; then
  for cand in "$HOME/.deno/bin/deno" /opt/homebrew/bin/deno /usr/local/bin/deno; do
    [ -x "$cand" ] && DENO_BIN="$cand" && break
  done
fi
[ -n "$DENO_BIN" ] || { echo "run-daemon: deno not found (set DENO_BIN)"; exit 1; }
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

# Serve live celld objects over a stable socket the shell connects to.
export RESAGENT_ENGINE="${RESAGENT_ENGINE:-celld}"
export RESAGENT_SOCKET="${RESAGENT_SOCKET:-$HOME/.resagent/run/resagent.sock}"
mkdir -p "$(dirname "$RESAGENT_SOCKET")"

cd "$RESAGENT_HOME"
exec "$DENO_BIN" run \
  --allow-read --allow-write --allow-net --allow-env --allow-run --allow-sys \
  src/daemon/main.ts
