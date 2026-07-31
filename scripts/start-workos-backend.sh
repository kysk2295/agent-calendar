#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${WORKOS_ENV_FILE:-$ROOT/.env.workos.local}"
EXPLICIT_AUTH_MODE="${WORKSPACE_AUTH_MODE-}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: WorkOS env file not found: $ENV_FILE" >&2
  echo "run npm run setup:workos or scripts/setup-workos-env.sh first" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -n "$EXPLICIT_AUTH_MODE" ]]; then
  export WORKSPACE_AUTH_MODE="$EXPLICIT_AUTH_MODE"
else
  export WORKSPACE_AUTH_MODE="${WORKSPACE_AUTH_MODE:-production}"
fi

for required_name in WORKOS_CLIENT_ID WORKOS_API_KEY DATABASE_URL; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "error: $required_name is required for WorkOS dogfood startup" >&2
    exit 1
  fi
done

echo "Starting WorkOS dogfood backend (auth mode: $WORKSPACE_AUTH_MODE, database: configured)"
exec npm run backend:start
