#!/bin/bash
# Wrapper launched by dev.resagent.minio.plist.
# Pulls the object-store root credentials from Keychain (never from disk/plist), then execs MinIO.
set -euo pipefail

RESAGENT_HOME="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$RESAGENT_HOME/data/minio"
mkdir -p "$DATA_DIR"

# Keychain-backed credentials (created by bootstrap.sh under service "dev.resagent.minio").
MINIO_ROOT_USER="$(security find-generic-password -s dev.resagent.minio -a access-key -w)"
MINIO_ROOT_PASSWORD="$(security find-generic-password -s dev.resagent.minio -a secret-key -w)"
export MINIO_ROOT_USER MINIO_ROOT_PASSWORD

# Localhost only — the object store is never exposed off-box.
exec minio server "$DATA_DIR" --address "127.0.0.1:9000" --console-address "127.0.0.1:9001"
