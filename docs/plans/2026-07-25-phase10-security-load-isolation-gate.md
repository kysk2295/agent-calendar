# Plan: Phase 10 security, load, and tenant-safe admission gate

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified local application gate; external edge and independent penetration gates remain

## Goal

프로덕션 Gateway가 무제한 요청 본문, 느린 업로드, 과도한 동시 요청, 한 호출자의
burst로 인해 전체 Workspace 서비스가 고갈되지 않게 한다. 제한 상태와 부하 결과는
테넌트·토큰·IP를 노출하지 않는 운영 지표로 관찰하고, 실제 HTTP 부하 리허설을
릴리스 증거로 남긴다.

## Non-Goals

- 외부 WAF, CDN, Railway rate limit 제품을 대신 구성하지 않는다.
- 실제 production 트래픽이나 고객 데이터를 사용하지 않는다.
- 토큰, IP, User ID, Workspace ID를 로그나 운영 지표 label로 남기지 않는다.
- 애플리케이션 수준의 요금제 quota나 Engine 사용량 과금을 구현하지 않는다.
- Mobile을 시작하지 않는다.

## Touched Boundaries

- Backend gateway: 요청 admission, 본문 제한, 서버 timeout 연결
- Backend library: production request safety와 observability readiness
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: 변경 없음
- Tests: 실제 HTTP body/admission/load/격리 계약
- Docs: 이 계획, 운영 runbook, redacted evidence, parent roadmap

## Success Criteria

- [x] JSON과 multipart 요청 본문은 production에서 환경별 상한을 가지며
      `Content-Length` 유무와 관계없이 초과 시 413으로 종료된다.
- [x] 본문 수신은 bounded timeout을 가지며 연결 종료 후 메모리와 listener를 정리한다.
- [x] 한 호출자의 burst는 opaque in-memory fingerprint 단위 429로 제한되고 다른
      호출자의 quota를 소비하지 않는다.
- [x] bearer 문자열 회전은 remote allowance를 우회하지 못하고 fingerprint 저장량은
      bounded capacity를 넘지 않는다.
- [x] 전체 in-flight 상한 초과는 503으로 fail fast하며 health endpoint는 살아 있다.
- [x] operations status는 accepted/rejected/in-flight 수만 노출하고 토큰, IP,
      User/Workspace/Runner 식별자를 노출하지 않는다.
- [x] 실제 HTTP 리허설에서 제한 응답, 회복, 병렬 정상 요청, redaction을 관찰한다.

## Edge Cases

- `Content-Length`가 거짓이거나 누락된 chunked body:
  - 실제 수신 byte 수로 다시 제한한다.
- 같은 bearer의 대소문자/공백 변형:
  - 인증 parser와 같은 bearer 의미만 fingerprint에 사용한다.
- 공개 로그인처럼 bearer가 없는 요청:
  - 원격 주소 기반 digest를 사용하되 원문 주소를 저장하거나 노출하지 않는다.
- 제한 중 health probe:
  - `/api/health`는 admission 제한에서 제외해 배포 플랫폼이 프로세스 생존을 판단한다.
- 응답 중 client disconnect:
  - in-flight count는 한 번만 반환되고 음수가 되지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] oversize/chunked body, per-caller 429, global 503, recovery, redaction 계약을
        구현 전에 실패시킨다.
- GREEN:
  - [x] 공통 bounded body reader와 production-only admission controller를 Gateway에 연결한다.
- REFACTOR:
  - [x] 세 곳의 중복 unbounded body reader를 하나의 fail-closed helper로 통합한다.

## Acceptance Gates

- [x] Phase 10 security/load narrow tests
- [x] 실제 local HTTP load rehearsal
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm test`
- [x] `git diff --check`

건너뛴 gate:

- External WAF/CDN/load balancer:
  - Reason: 별도 운영 계정과 public deployment가 필요하며 이 로컬 gate는 앱 내부
    방어와 redacted evidence를 검증한다.
- Desktop manual QA:
  - Reason: 제품 UI나 Desktop API 계약을 변경하지 않는 Gateway 운영 경계다.

## Implementation Checklist

- [x] Step 1: 현재 Gateway body/admission/timeout 경계를 감사한다.
- [x] Step 2: 실패하는 실제 HTTP 안전 계약을 작성한다.
- [x] Step 3: bounded body reader와 admission controller를 구현·연결한다.
- [x] Step 4: 실제 부하 리허설과 전체 regression을 통과시킨다.
- [x] Step 5: 운영 runbook, evidence, roadmap을 갱신한다.

## Rollback

- request safety module과 Gateway wiring만 이전 build로 되돌린다.
- DB schema와 persisted data를 바꾸지 않으므로 migration rollback은 없다.
- 환경 변수를 제거하면 안전한 기본 상한을 사용하며 production에서 무제한 모드로
  조용히 전환하지 않는다.

## Verification Notes

- Current audit:
  - Gateway, Phase 1 auth, production dispatcher에 서로 다른 unbounded body reader가 있다.
  - server-level request/header timeout과 application admission limit가 없다.
  - operations monitor는 active request를 관찰하지만 고갈 전에 요청을 거부하지 않는다.
- RED:
  - `node --test apps/backend/tests/phase10-security-load-gate.test.cjs`
  - Result: 새 request safety 모듈 부재로 예상한 `MODULE_NOT_FOUND`.
- Narrow:
  - security/load 9/9, adjacent observability 포함 14/14 통과.
- Actual local HTTP rehearsal:
  - 100 requests / concurrency 20: 100 successful, client p95 34ms, max 43ms,
    Gateway p95 1ms.
  - chunked overflow 413; caller burst 429; 다른 caller 200.
  - capacity 503 중 health 200; release 뒤 원 요청과 새 요청 모두 200.
  - Evidence: `docs/operations/evidence/2026-07-25-phase10-security-load-isolation.json`.
- Regression:
  - `npm run backend:check`: passed.
  - `npm run test:backend`: 439/439 passed.
  - `npm test`: Backend 439/439, Desktop 244/244, Runner 23/23 passed.
  - 한 중간 실행에서 기존 Calendar AI PostgreSQL polling 테스트가 한 번 `null` 응답으로
    실패했지만 단일 재현은 통과했고, 이후 backend 단독 및 전체 suite가 연속 통과했다.
  - Desktop suite emitted existing non-failing Vite dependency WebSocket port warnings.
- Static:
  - `git diff --check`: passed.

## Remaining Risks

- 단일 프로세스 in-memory limiter는 여러 Railway replica 사이 quota를 공유하지 않는다.
  - Mitigation: 각 replica의 자원 고갈을 막는 최종 방어선으로 사용하고, public 운영 전
    외부 WAF/edge global limit를 별도 gate로 둔다.
