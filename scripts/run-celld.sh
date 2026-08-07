#!/bin/bash
# Wrapper launched by dev.resagent.celld.plist.
# Reads the S3 (MinIO) credentials from Keychain, waits for the bucket, then execs celld.
set -euo pipefail

RESAGENT_HOME="$(cd "$(dirname "$0")/.." && pwd)"
CELLD_BIN="${CELLD_BIN:-$HOME/.local/bin/celld}" # installer target (confirmed via celld.dev/docs)
BUCKET="${RESAGENT_BUCKET:-resagent}"
S3_ENDPOINT="http://127.0.0.1:9000"

AWS_ACCESS_KEY_ID="$(security find-generic-password -s dev.resagent.minio -a access-key -w)"
AWS_SECRET_ACCESS_KEY="$(security find-generic-password -s dev.resagent.minio -a secret-key -w)"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

# Wait for MinIO to accept connections (launchd starts both agents; ordering isn't guaranteed).
for _ in $(seq 1 30); do
  if curl -fsS "$S3_ENDPOINT/minio/health/live" >/dev/null 2>&1; then break; fi
  sleep 1
done

# Flags confirmed against celld.dev/docs. celld uses the standard AWS credential chain (the
# AWS_* exports above). --listen is documented as a fleet-node flag; we bind it explicitly to
# localhost to keep the router off-box (aligned with the localhost-first security posture).
exec "$CELLD_BIN" \
  --bucket "s3://$BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region us-east-1 \
  --listen "127.0.0.1:8080"
