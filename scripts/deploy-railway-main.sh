#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing Railway deploy: working tree is not clean." >&2
  exit 1
fi

branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
  echo "Refusing Railway deploy: current branch is '$branch', not 'main'." >&2
  exit 1
fi

commit="$(git rev-parse HEAD)"
origin_commit="$(git rev-parse origin/main)"
if [[ "$commit" != "$origin_commit" ]]; then
  echo "Refusing Railway deploy: local main is not synchronized with origin/main." >&2
  exit 1
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "Refusing Railway deploy: Railway CLI is not installed." >&2
  exit 1
fi

railway variable set "SOURCE_COMMIT=$commit" --skip-deploys >/dev/null
railway up --ci --message "main@${commit:0:12}"

echo "Railway deployment uploaded from main@${commit:0:12}."
