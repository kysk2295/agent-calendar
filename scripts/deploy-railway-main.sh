#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_ID="b64a9c8f-101e-4e08-9a7f-68fea0a4de9a"
ENVIRONMENT_ID="7629b09d-3447-4f74-9b06-2f9b8aafb80a"
SERVICE_ID="b7bd75ff-cc24-4a6d-9387-1628fcaff9d6"
EXPECTED_SOURCE_REPO="kysk2295/agent-calendar"

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

PREFLIGHT_PATH="${RAILWAY_RELEASE_PREFLIGHT_PATH:-}"
if [[ -z "$PREFLIGHT_PATH" || ! -f "$PREFLIGHT_PATH" ]]; then
  echo "Refusing Railway deploy: successful staging preflight file is required." >&2
  exit 1
fi

preflight_summary="$(node -e '
const fs = require("node:fs");
const document = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expectedCommit = String(process.argv[2] || "");
const required = [
  document.candidateDeploymentId,
  document.lastKnownGoodDeploymentId,
  document.stagingEnvironmentId,
  document.stagingServiceId,
];
const verifiedAt = Date.parse(document.verifiedAt);
const expiresAt = Date.parse(document.expiresAt);
const now = Date.now();
if (
  document.schemaVersion !== 3
  || document.ok !== true
  || document.action !== "promote_candidate"
  || document.candidateCommit !== expectedCommit
  || required.some((value) => !String(value || "").trim())
  || !Number.isFinite(verifiedAt)
  || !Number.isFinite(expiresAt)
  || verifiedAt > now + 5 * 60 * 1000
  || expiresAt <= verifiedAt
  || expiresAt - verifiedAt > 30 * 60 * 1000
  || now > expiresAt
) {
  process.exit(3);
}
process.stdout.write([
  document.candidateDeploymentId,
  document.lastKnownGoodDeploymentId,
].join("\t"));
' "$PREFLIGHT_PATH" "$commit")" || {
  echo "Refusing Railway deploy: staging preflight is missing, failed, or does not match current commit." >&2
  exit 1
}
IFS=$'\t' read -r STAGING_CANDIDATE_ID LAST_KNOWN_GOOD_ID <<< "$preflight_summary"

if ! command -v railway >/dev/null 2>&1; then
  echo "Refusing Railway deploy: Railway CLI is not installed." >&2
  exit 1
fi

services_json="$(railway service list \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT_ID" \
  --json)"

source_repo="$(printf '%s' "$services_json" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const services = JSON.parse(input);
  const service = services.find((entry) => entry && entry.id === process.argv[1]);
  if (!service) process.exit(3);
  process.stdout.write(String(service.source?.repo || ""));
});
' "$SERVICE_ID")"

if [[ "$source_repo" != "$EXPECTED_SOURCE_REPO" ]]; then
  echo "Refusing Railway deploy: service source must be '$EXPECTED_SOURCE_REPO', found '${source_repo:-none}'." >&2
  exit 1
fi

railway redeploy \
  --from-source \
  --yes \
  --json \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT_ID" \
  --service "$SERVICE_ID" >/dev/null

echo "Railway source deployment requested for main@${commit:0:12} on service $SERVICE_ID after staging candidate $STAGING_CANDIDATE_ID; last-known-good $LAST_KNOWN_GOOD_ID."
