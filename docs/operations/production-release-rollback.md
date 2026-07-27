# Production release and rollback

## 목적

Gateway와 Runner를 새 버전으로 바꿀 때 현재 사용 가능한 정상 버전을 먼저 고정하고,
승격 조건이 하나라도 맞지 않으면 release를 중단한다. Gateway와 Runner의 상태·secret
경계는 서로 다르므로 같은 updater나 credential을 공유하지 않는다.

## Gateway release

### Railway 설정

루트 `railway.json`이 production source deployment의 기준이다.

- liveness: `/api/health`
- health timeout: 30초
- old/new deployment overlap: 60초
- SIGTERM 이후 draining: 30초
- restart: `ON_FAILURE`, 최대 3회

Railway의 old/new overlap은 새 deployment가 active가 된 뒤 이전 deployment를 잠시
유지한다. 이것이 staging 검증을 대체하지는 않는다. staging은 production과 별도
PostgreSQL, 별도 secret을 사용해야 한다.

### 승격 순서

1. reviewed commit을 `main`에 push하고 local `main`, `origin/main`, release commit이 같은지
   확인한다.
2. isolated staging에 같은 commit을 배포한다.
3. staging `/api/health=200`, `/api/ready=200`, clean-account ETE를 실행하고 각 실행기가
   아래 구조화 증거를 출력하게 한다.

먼저 Railway staging service의 `latestDeployment`에서 만든 candidate binding JSON과
public HTTPS origin으로 readiness 증거를 만든다.

```sh
node scripts/railway-release-gate.cjs probe-readiness \
  --base-url "$STAGING_BASE_URL" \
  --binding-json "$STAGING_CANDIDATE_BINDING_JSON" \
  > "$STAGING_READINESS_EVIDENCE_JSON"
```

readiness producer는 redirect 없이 `/api/gateway-status`, `/api/health`, `/api/ready`만
조회한다. 세 응답이 모두 성공하고 public status의 deployment ID와 12–40자리 commit
prefix가 candidate binding의 exact deployment/full commit과 일치할 때만 증거를 쓴다.
URL, response body, header, 사용자 데이터는 출력하지 않으며 비정상 JSON과 64KiB를 넘는
응답도 bounded 오류로 거부한다.

실제 WorkOS clean-account 실행 전에 repository preflight도 통과해야 한다.

```sh
npm run verify:staging-clean-account
```

이 명령은 CLI 인자로 live configuration을 받지 않는다. secret manager가 권한 `0600`의
repository 외부 파일로 주입한 `AGENT_CALENDAR_STAGING_CONFIG_PATH`와 다음 delivery
metadata를 process environment에 제공해야 한다.

- `AGENT_CALENDAR_STAGING_CONFIG_SOURCE=secret-manager`
- `AGENT_CALENDAR_STAGING_SECRET_MANAGER`: 허용된 secret manager 종류
- `AGENT_CALENDAR_STAGING_WORKOS_AUTHORITY_REF`: `secret://` reference
- `AGENT_CALENDAR_STAGING_ENGINE_AUTHORITY_REF`: `secret://` reference

configuration은 public HTTPS staging origin, 30분 이내에 결속한 full commit과
deployment/environment/service ID, live WorkOS AuthKit 및 live Engine provenance만
가진다. credential, cookie, token, 사용자/Workspace 식별자, 임의 instruction은
configuration에 넣지 않는다. local/private endpoint, injected AuthKit, Fake Engine,
stale binding, symlink 또는 권한이 넓은 live configuration은 즉시 거부된다.

출력은 candidate binding과 allowlist된 capability category만 포함한다.
`preflightReady=true`여도 `ok=false`, `journeyVerified=false`이므로 clean-account 성공
증거가 아니다. 실제 journey 권한이 없으면 nonzero `blocked` JSON을 기록하고 중단한다.
로컬 hostile configuration 검사에는 side effect가 없는 다음 명령만 사용한다.

```sh
node scripts/staging-workos-clean-account.cjs preflight --config "$HOSTILE_FIXTURE"
```

로컬 producer 계약은 Phase 3 Golden ETE의 live Engine 모드로 검증한다. binding은
반드시 현재 검증 대상의 full commit과 environment/service/deployment 식별자여야 한다.

```sh
AGENT_CALENDAR_E2E_LIVE_ENGINE=codex \
AGENT_CALENDAR_E2E_RELEASE_EVIDENCE_PATH="$CLEAN_ACCOUNT_ETE_EVIDENCE_JSON" \
AGENT_CALENDAR_E2E_RELEASE_BINDING_JSON="$CANDIDATE_BINDING_JSON" \
node apps/desktop/tests/playwright-phase3-golden-ete.cjs
```

이 명령의 현재 기본 실행 대상은 ephemeral local Gateway다. 따라서 local binding으로 만든
증거는 producer 계약 검증에만 사용하고 Railway staging 승격에는 사용할 수 없다. 실제
staging에서는 외부 candidate URL과 live WorkOS test account를 사용하는 release harness가
같은 JSON 계약을 출력한 뒤에만 다음 단계로 진행한다. Fake Engine, expected-failure ETE,
로그인 replay, 누락된 checkpoint/Calendar/reconnect, 동일한 상태 screenshot은 producer가
증거 생성을 거부한다.
4. Railway Public API에서 production의 현재 deployment와 retained `canRollback`
   deployment를 조회한다. Railway CLI의 `deployment list --json`에는 `canRollback`이
   없으므로 release preflight 입력으로 사용하지 않는다.

Account/Workspace/OAuth token은 `RAILWAY_API_TOKEN`, environment-scoped Project Token은
`RAILWAY_PROJECT_TOKEN`으로 secret manager에서 주입한다. 정확히 하나만 있어야 한다.

```sh
node scripts/railway-release-gate.cjs snapshot-deployments \
  > "$RAILWAY_PRODUCTION_DEPLOYMENTS_JSON"
```

snapshot 명령은 고정 Agent Calendar production project/environment/service에서 최대 20개만
읽는다. 출력은 deployment ID, status, createdAt, `canRollback`, source repo, full commit
SHA로 제한된다. token, URL, image digest, commit message, raw metadata는 출력하지 않는다.
5. 전체 environment status와 production deployment history JSON, staging readiness 증거,
   clean-account ETE 증거를 민감값이 없는 임시 파일로 저장한다. staging candidate는
   status의 staging service `latestDeployment`에서 찾고, rollback 대상은 production
   deployment history에서만 찾는다.
6. release preflight를 실행한다.

```sh
node scripts/railway-release-gate.cjs preflight \
  --status-json "$RAILWAY_STATUS_JSON" \
  --deployments-json "$RAILWAY_PRODUCTION_DEPLOYMENTS_JSON" \
  --expected-commit "$RELEASE_COMMIT" \
  --readiness-evidence-json "$STAGING_READINESS_EVIDENCE_JSON" \
  --smoke-evidence-json "$CLEAN_ACCOUNT_ETE_EVIDENCE_JSON" \
  --staging-isolation-evidence-json "$STAGING_ISOLATION_EVIDENCE_JSON" \
  > "$RAILWAY_PREFLIGHT_JSON"
```

readiness 증거는 `schemaVersion=1`, `kind=gateway_readiness`, 수집 시각, candidate
deployment/commit/environment/service 결속값, `/api/ready`와 `/api/health`의 HTTP 200
및 `ok=true`, `/api/gateway-status`의 exact deployment ID와 matching commit prefix를
가진다.
clean-account ETE 증거는 schema 2이며 같은 결속값, 실제 WorkOS AuthKit
identity provenance와 다음 일곱 결과를 모두 가진다.

- `identity.provider=workos_authkit`
- `identity.liveTenant=true`
- `identity.injectedAdapter=false`

- Workspace 로그인
- Runner 등록
- 실행 엔진 인증
- 위임 작업 완료
- 실시간 체크포인트 관찰
- Calendar 결과 확인
- 재접속 상태 복원

staging isolation 증거는 아래 producer가 현재 Railway environment와 양쪽
`DATABASE_URL`을 직접 읽어 생성한다. connection string 원문은 출력하지 않고,
production/staging database service instance와 endpoint fingerprint가 서로 다른지만
기록한다.

```sh
node scripts/railway-release-gate.cjs snapshot-staging-isolation \
  > "$STAGING_ISOLATION_EVIDENCE_JSON"
```

증거에는 사용자, Workspace ID, provider token, request header를 넣지 않는다. 증거는
수집 후 30분만 유효하며 5분을 넘는 미래 시각도 거부한다.

7. `schemaVersion=3`, `ok=true`, `action=promote_candidate`, candidate commit,
   staging identifiers, last-known-good deployment ID, `verifiedAt`, `expiresAt`을 검토한다.
8. production deploy는 이 preflight 파일 없이는 실행되지 않는다.

```sh
RAILWAY_RELEASE_PREFLIGHT_PATH="$RAILWAY_PREFLIGHT_JSON" \
  scripts/deploy-railway-main.sh
```

deploy script는 만료되었거나 30분보다 긴 preflight, 미래 시각 preflight, 현재 commit과
다른 preflight를 거부한다.

9. 새 production deployment의 `/api/ready=200`과 clean-account ETE를 다시 확인한다.

preflight JSON과 deployment JSON에는 token, variable 값, request header, 사용자 또는
Workspace 데이터가 들어가면 안 된다.

### Gateway rollback

새 production이 readiness 또는 smoke를 잃으면 트래픽을 계속 승격하지 않는다. Railway
API에서 `canRollback=true`인 정확한 last-known-good ID만 선택한다.

```sh
node scripts/railway-release-gate.cjs rollback \
  --deployments-json "$RAILWAY_DEPLOYMENTS_JSON" \
  --current-deployment-id "$CURRENT_DEPLOYMENT_ID" \
  --target-deployment-id "$LAST_KNOWN_GOOD_ID" \
  --confirm "ROLLBACK:$LAST_KNOWN_GOOD_ID"
```

rollback도 snapshot과 동일하게 `RAILWAY_API_TOKEN` 또는 `RAILWAY_PROJECT_TOKEN` 중
정확히 하나를 secret manager에서 주입한다.

rollback은 선택한 deployment의 image와 당시 variables를 새 deployment로 복원한다.
retention 밖의 deployment는 `canRollback=false`이므로 도구가 거부한다. rollback 뒤에도
`/api/ready`와 clean-account smoke를 다시 통과해야 한다.

## Runner release

Runner의 device identity, Workspace credential, local Knowledge source는 release 설치
루트 바깥의 Runner state directory에 남는다. updater는 이 디렉터리를 인자로 받지
않으며 수정하지 않는다.

### Artifact finalization

1. `apps/runner`를 stable semver archive로 패키징한다.
2. release signing private key는 CI secret에서만 읽는다.
3. manifest에 full commit SHA, protocol/state schema, platform, rollout percentage,
   artifact size와 SHA-256을 넣고 Ed25519로 서명한다.

```sh
node apps/runner/tools/runner-release-artifacts.cjs finalize \
  --artifact "$RUNNER_ARTIFACT" \
  --version "$RUNNER_VERSION" \
  --commit-sha "$RELEASE_COMMIT" \
  --private-key "$RUNNER_SIGNING_PRIVATE_KEY_PATH" \
  --output "$RUNNER_MANIFEST"
```

private key는 Runner host로 전달하지 않는다. 초기 signed/notarized bootstrap에 release
public key를 고정하고 update에는 public key만 사용한다.

### Atomic install

```sh
node apps/runner/bin/agent-calendar-runner-update.js install \
  --artifact "$RUNNER_ARTIFACT" \
  --manifest "$RUNNER_MANIFEST" \
  --trusted-public-key "$RUNNER_RELEASE_PUBLIC_KEY_PATH" \
  --install-root "$RUNNER_INSTALL_ROOT"
```

updater는 다음 순서로 동작한다.

1. manifest signature, artifact checksum/size, stable version, protocol/state compatibility,
   platform을 검증한다.
2. archive traversal과 symbolic link를 거부한다.
3. immutable `releases/<version>-<commit>`에 푼다.
4. 승격 전 Runner version health check를 실행한다.
5. `current` symlink를 원자적으로 바꾼다.
6. 승격 후 health check가 실패하면 이전 `current`로 즉시 복귀한다.

상태 확인:

```sh
node apps/runner/bin/agent-calendar-runner-update.js status \
  --install-root "$RUNNER_INSTALL_ROOT"
```

## 현재 증거와 남은 관문

- Runner local atomic rollback:
  `docs/operations/evidence/2026-07-25-phase10-runner-rollback.json`
- Railway current-state audit:
  `docs/operations/evidence/2026-07-25-phase10-gateway-release-readiness.json`
- Candidate readiness producer:
  `docs/operations/evidence/2026-07-25-phase10-candidate-readiness-evidence.md`

현재 Railway production은 staging 부재와 old deployment drift 때문에 승격 준비가
완료되지 않았다. production deploy/rollback evidence는 staging 생성, reviewed main
push, Railway API token, retained rollback candidate가 모두 준비된 뒤에만 추가한다.

Runner public artifact는 별도의 Developer ID signing/notarization과 GitHub draft Release
gate를 통과하기 전에는 stable channel에 공개하지 않는다.
