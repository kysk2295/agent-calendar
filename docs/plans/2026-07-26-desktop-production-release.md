# Plan: Desktop production release

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress

## Goal

Agent Calendar Desktop을 실제 macOS 배포 기준으로 완성한다. 서명된 앱에서 실제 WorkOS 로그인, Calendar 조회, Agent Builder와 Work Conversation·handoff·session 기능, Delegated Work 실행, 설치와 업데이트 복구가 한 번 확인되면 완료한다.

## Non-Goals

- Mobile과 Phase 10 Mobile gate
- 에이전트 회의와 스킬 마켓 같은 post-v1 확장 기능
- Telegram 절체와 Web 공개 런칭
- 28일 private-beta 대기
- 전수 적대 검증과 반복 회귀 실행
- 출시를 막지 않는 구조 리팩터링

## Touched Boundaries

- Backend gateway: Desktop 로그인과 Delegated Work에 필요한 기존 경로만
- Backend library: 실제 staging 여정에서 발견된 blocker만
- DB/migrations: 새 migration 없음
- Electron bridge: secure session과 packaged startup
- React UI: 실제 핵심 여정 blocker만
- Tests: 좁은 회귀 테스트와 한 번의 matching-surface smoke
- Docs: release handoff와 rollback

## Success Criteria

- [ ] Typecheck와 Desktop build가 한 번 통과한다.
- [ ] Packaged Desktop이 Keychain 오류 없이 실행·저장·재실행된다.
- [ ] Agent Builder, effective configuration/grants, Work Conversation, child handoff, session rebind/fork, current-result 채택의 대표 기획 여정이 성공한다.
- [ ] 실제 staging WorkOS 로그인과 Calendar 조회가 성공한다.
- [ ] 실제 Runner로 Delegated Work 한 건이 완료된다.
- [ ] 서명·공증·staple·Gatekeeper 검증된 후보가 설치된다.
- [ ] 업데이트 실패 후 세션과 Runner 상태를 보존한 채 복구된다.

## Edge Cases

- 빈 첫 실행에서는 존재하지 않는 암호문을 읽기 위해 Keychain을 호출하지 않는다.
- staging 또는 signing 권한이 없으면 로컬 fixture를 출시 성공으로 간주하지 않는다.
- 실패 복구는 사용자 데이터나 Runner identity를 초기화하지 않는다.

## Test Plan

- RED: 실제 packaged/staging/release 표면에서 blocker가 재현될 때만 가장 좁은 회귀 테스트를 추가한다.
- GREEN: blocker를 제거하는 최소 변경만 한다.
- REFACTOR: 이번 범위에서는 하지 않는다.

## Acceptance Gates

- [ ] `npm run typecheck`
- [ ] `npm run build:desktop`
- [ ] 변경된 Backend/Runner의 syntax check
- [ ] packaged Desktop 한 번 실행·저장·재실행
- [ ] Agent focused tests 각각 한 번과 Desktop 대표 Agent 통합 여정 한 번
- [ ] 실제 staging 핵심 여정 한 번
- [ ] 정확한 후보 서명·공증·설치·업데이트/복구 한 번

건너뛴 gate:

- Full test suites and repeated adversarial matrices:
  - Reason: 사용자가 검증 최소화와 오버엔지니어링 금지를 명시했다.

## Implementation Checklist

- [ ] 현재 dirty worktree를 Desktop 필수/보류/제외로 분류한다.
- [ ] 로컬 Desktop 출시 기준을 한 번 통과시킨다.
- [ ] Agent 핵심 기획 계약을 focused tests와 대표 Desktop 여정으로 한 번 확인한다.
- [ ] staging 권한을 받아 실제 핵심 여정을 한 번 수행한다.
- [ ] signing 권한을 받아 후보를 만들고 한 번 설치·복구한다.
- [ ] 릴리스 인계 문서를 확정한다.

## Verification Notes

- Existing Keychain evidence:
  - Ordinary native empty boot 3/3 produced zero availability/encrypt/decrypt calls and zero prompt.
  - Save/relaunch restored encrypted session and Workspace snapshot without plaintext on disk.

## Remaining Risks

- staging과 Apple 자격 증명 제공 전에는 실제 출시 완료가 불가능하다.
- 이전 목표의 대규모 미커밋 변경을 보존하면서 Desktop 후보 범위를 분리해야 한다.
