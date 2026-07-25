# Plan: Phase 8 Encrypted Cold-Start Workspace Snapshot

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Verified
- Parent: `docs/plans/2026-07-24-production-development-roadmap.md`
- Predecessor: `docs/plans/2026-07-25-phase8-desktop-offline-reconnect.md`

## Goal

로그인한 Desktop이 정상 동기화 뒤 완전히 종료되었더라도 네트워크 없이 다시 열면 같은
Workspace의 마지막 정상 Calendar와 제품 상태를 즉시 보여 준다. 보관 데이터는 macOS
보안 저장소로 암호화하고, 다른 User/Workspace, 로그아웃, 만료된 보관본에는 절대
노출하지 않는다.

## Non-Goals

- 오프라인 변경·작업 실행·일정 생성 큐
- 여러 Workspace 사이를 오프라인으로 전환하는 UI
- 서버 백업 또는 PostgreSQL PITR 대체
- 자동 업데이트, 코드 서명, notarization
- Web 또는 Mobile 캐시

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 암호화된 Workspace snapshot store와 owner-authorized IPC
- React UI: boot 시 cache restore, 정상 hydration 뒤 snapshot 저장
- Tests: 암호화/격리/보존 테스트, cold-start offline Electron ETE
- Docs: 이 계획, Phase 8 roadmap, redacted evidence

## Success Criteria

- [x] 정상 hydration의 Calendar, Agent Work, Wiki, Automation, Runner, Calendar AI
      presentation state를 암호화된 단일 snapshot으로 저장한다.
- [x] snapshot 파일에는 일정 제목, 문서 내용, User/Workspace ID가 평문으로 나타나지
      않고 owner-only 파일 권한을 사용한다.
- [x] 현재 secure session의 User와 Workspace가 둘 다 일치할 때만 snapshot을 읽는다.
- [x] 다른 User/Workspace, 손상, 7일 초과, 8 MiB 초과 데이터는 fail closed하고
      보관본을 제거한다.
- [x] 명시적 로그아웃과 확정된 세션 폐기는 snapshot을 제거한다.
- [x] cold-start offline 상태에서도 로그인 화면이나 빈 Calendar 대신 보관 일정과
      마지막 동기화 시각을 보여 준다.
- [x] Gateway 복구 뒤 재로그인 없이 최신 Workspace state로 전환한다.
- [x] 다른 Workspace의 renderer 입력은 snapshot 권한을 만들 수 없다.

## Edge Cases

- access token refresh 시 네트워크만 실패하고 secure refresh session은 남아 있음
- refresh API의 429/5xx 응답은 일시 장애로 취급하고 secure session과 snapshot을 보존함
- refresh API가 명시적으로 세션을 거부해 secure session이 폐기됨
- 로그인 전환 중 이전 Workspace hydration이 늦게 완료됨
- 같은 Workspace의 여러 hydration이 시작 순서와 반대로 완료됨
- snapshot 암호문이 잘리거나 다른 키로 암호화됨
- 이전 Workspace의 snapshot이 남은 상태에서 다른 계정으로 로그인함
- hydration payload가 용량 제한을 초과함
- snapshot 저장 도중 앱이 종료됨

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] `workspace-snapshot.test.mjs`가 없는 암호화 store 때문에 실패한다.
  - [x] Phase 8 Electron ETE가 Gateway를 끈 채 재실행하면 보관 일정 대신 빈/로딩
        화면을 보여 실패한다.
  - [x] retryable refresh 응답과 out-of-order/cross-session hydration 회귀 테스트가
        기존 clear/last-finisher 동작 때문에 실패한다.
- GREEN:
  - [x] safeStorage 기반 atomic 0600 snapshot store와 session-owned IPC를 구현한다.
  - [x] Renderer가 cache를 먼저 적용한 뒤 background hydrate와 기존 reconnect 흐름을
        실행한다.
  - [x] 로그아웃과 definitive session invalidation에서 snapshot을 제거한다.
  - [x] hydration generation과 secure session ID를 함께 검증해 이전 User/Workspace나
        이전 hydration의 UI 적용과 snapshot 저장을 거부한다.
- REFACTOR:
  - [x] snapshot validation/retention/size 정책을 Electron 모듈에 모으고 App에는
        presentation apply/save orchestration만 둔다.

## Acceptance Gates

- [x] Workspace snapshot unit tests
- [x] Secure session regression tests
- [x] Phase 8 cold-start offline/reconnect Electron ETE
- [x] Phase 8 session truth Electron ETE
- [x] Phase 3 golden ETE
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Light/dark cold-start screenshot review
- [x] Independent read-only security/code review

건너뛴 gate:

- Live WorkOS/Railway:
  - Reason: deterministic fake AuthKit/Gateway failure controls the exact offline and cross-session
    conditions without mutating external accounts. Live credentials remain a release gate.

## Implementation Checklist

- [x] Step 1: 계획과 retention/security policy 고정
- [x] Step 2: 암호화 store unit RED
- [x] Step 3: cold-start offline Electron RED
- [x] Step 4: snapshot store와 owner-authorized IPC GREEN
- [x] Step 5: Renderer restore/save orchestration GREEN
- [x] Step 6: logout/session-failure deletion과 reconnect 검증
- [x] Step 7: adjacent ETE, full gates, reviewer, evidence

## Rollback

- IPC와 renderer cache restore를 제거하면 기존 실행 중 offline retention 동작으로
  돌아간다.
- snapshot은 서버/DB 계약을 바꾸지 않는다. 롤백 시 `workspace-snapshot.enc` 파일만
  무시하며 다음 로그아웃 또는 새 버전의 cleanup에서 제거할 수 있다.

## Verification Notes

- RED:
  - 암호화 store가 없을 때 unit test가 module-not-found로 실패했다.
  - 보관본 구현 전 Electron ETE는 완전 종료 후 offline 재실행에서
    `Reconnect proof event`를 찾지 못해 실패했다.
  - 보안 검토가 429/503 session 삭제, cross-session hydration, out-of-order 저장을
    차단 이슈로 발견했고 추가 회귀 테스트가 기존 동작에서 실패했다.
- Narrow GREEN:
  - secure session, snapshot, hydration/write gate tests 18/18 passed.
  - 429/503과 transport 오류는 session/snapshot을 보존하고, 확정된 401은 폐기한다.
  - 다른 secure session ID와 이전 hydration generation의 UI 적용/저장을 거부한다.
  - 암호문은 파일 크기 상한을 먼저 검사한 뒤에만 읽고 복호화한다.
- Product surface:
  - light/dark 실제 Electron ETE가 정상 동기화 → 실행 중 offline → 복구 → 완전 종료 →
    cold-start offline → 복구를 재로그인 없이 통과했다.
  - 두 테마 모두 보관 일정, 마지막 동기화 시각, 정직한 offline 상태를 표시했고
    logout 뒤 session/snapshot 파일을 제거했다.
- Adjacent:
  - Phase 8 session truth ETE passed (`completeCount=1`, restart restore, stale profile truth).
  - Phase 3 golden ETE passed (Backend/Desktop restart, terminal 1, Calendar event 1).
- Full gates:
  - `npm run backend:check`, `npm run typecheck`, `npm run build:desktop` passed.
  - Desktop tests 217/217, Runner tests 19/19, full `npm test` passed.
- Independent review:
  - Initial verdict `REQUEST_CHANGES`; all three blockers and the encrypted read size issue fixed.
  - Final verdict `PASS`, report `.omo/evidence/cold_snapshot_security_review-code-review.md`.
- Evidence:
  - `docs/operations/evidence/2026-07-25-phase8-encrypted-cold-start-snapshot.json`

## Remaining Risks

- 캐시는 7일 동안의 읽기 전용 편의 사본이며 서버 백업이 아니다.
- 원격 세션 폐기는 기기가 offline인 동안 즉시 알 수 없으며, 다음 성공적인 인증 통신
  또는 로컬 로그아웃에서 확정된다.
- OS 계정이 잠금 해제된 동안 실행되는 악성 로컬 프로세스는 safeStorage의 플랫폼
  위협 모델 밖이다.
