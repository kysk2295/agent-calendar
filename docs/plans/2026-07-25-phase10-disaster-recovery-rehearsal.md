# Plan: Phase 10 disaster recovery rehearsal

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified local slice; Railway managed recovery remains an external gate

## Goal

현재 0001-0024 전체 PostgreSQL 스키마를 대상으로 논리 백업 복원과 실제 WAL 기반
PITR을 로컬 격리 클러스터에서 재현한다. 두 Workspace의 데이터가 복구 뒤에도 유지되고
RLS로 서로 보이지 않으며, 사고 뒤 변경은 지정한 복구 지점에서 제외되는 것을 증명한다.

## Non-Goals

- Railway 또는 다른 원격 데이터베이스에 접속하거나 변경하지 않는다.
- 실제 사용자 데이터, `DATABASE_URL`, 토큰 또는 운영 백업을 읽지 않는다.
- Railway의 관리형 백업 보존 정책이나 실제 운영 RPO/RTO를 통과했다고 주장하지 않는다.
- product schema나 API 계약을 변경하지 않는다.
- blue-green 배포, Desktop 또는 Runner binary rollback은 이 리허설에 포함하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: `apps/backend/app/lib/phase10-disaster-recovery.js`
- Backend tools: `apps/backend/tools/phase10-disaster-recovery-rehearsal.cjs`
- DB/migrations: 0001-0024를 변경 없이 실제 적용
- Electron bridge: 변경 없음
- React UI: 변경 없음
- Tests: `apps/backend/tests/phase10-disaster-recovery.test.cjs`
- Docs: 이 계획, 운영 런북, redacted evidence

## Success Criteria

- [x] 외부 DB URL과 비어 있지 않은 작업 경로를 실행 전에 거부한다.
- [x] 현재 전체 migration table inventory를 동적으로 계산하고 백업과 복원에서 일치시킨다.
- [x] 두 Workspace fixture와 핵심 Calendar 레코드를 논리 dump/restore 후 digest로 비교한다.
- [x] app role RLS 조회가 각 Workspace 데이터만 반환한다.
- [x] physical base backup과 archived WAL로 이름 있는 사고 직전 restore point까지 복구한다.
- [x] 복구 지점 전 안전 변경은 보이고 그 뒤 삭제 및 damage marker는 보이지 않는다.
- [x] source와 recovery PostgreSQL이 모두 중지된 뒤에만 `ok=true`를 출력한다.
- [x] 보고서에는 연결 문자열, 절대 사용자 경로, row payload 또는 secret-shaped 값이 없다.

## Edge Cases

- PostgreSQL 또는 `pg_basebackup` 누락 시 명확한 prerequisite 결과로 종료한다.
- pgvector extension이 없으면 schema 일부만 적용했다고 주장하지 않고 실패한다.
- archive WAL이 복구 지점까지 도착하지 않으면 PITR 성공을 주장하지 않는다.
- 복구 target에 사용자 table이 있거나 postmaster가 남으면 실패한다.
- RLS 조회에서 다른 Workspace ID가 하나라도 보이면 전체 리허설이 실패한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] current schema inventory, two-Workspace fixture, PITR state, redaction 계약이 모듈 부재로 실패한다.
- GREEN:
  - [x] 순수 계약 모듈과 안전한 ephemeral PostgreSQL CLI를 구현한다.
- REFACTOR:
  - [x] 기존 Phase 0 안전 helper를 재사용하고 production 연결 경로는 만들지 않는다.

## Acceptance Gates

- [x] `node --test apps/backend/tests/phase10-disaster-recovery.test.cjs`
- [x] 실제 임시 디렉터리에서 dump/restore/PITR CLI 성공
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `git diff --check`

건너뛴 gate:

- Railway managed backup/PITR:
  - 실제 production project와 retention 설정은 외부 운영 권한이 필요한 별도 Phase 10 gate다.
- Desktop/Runner/Web:
  - DB 운영 도구만 변경하므로 해당 제품 표면을 변경하지 않는다.

## Implementation Checklist

- [x] Step 1: Phase 0 복구 리허설과 현재 Phase 10 요구의 차이를 감사한다.
- [x] Step 2: 실패하는 current-schema/PITR 계약을 작성한다.
- [x] Step 3: 격리 클러스터 논리 복원과 WAL PITR 도구를 구현한다.
- [x] Step 4: 실제 리허설, backend regression, redaction 검사를 실행한다.
- [x] Step 5: 운영 런북, evidence, roadmap 상태를 갱신한다.

## Rollback

- 새 library, tool, test, docs만 제거하면 이전 상태로 돌아간다.
- migration과 product runtime을 변경하지 않으므로 데이터 rollback은 없다.
- 리허설은 `mktemp` 하위의 격리 클러스터만 만들고 종료 후 운영자가 해당 임시 경로를
  삭제할 수 있다.

## Verification Notes

- Phase 0 tool은 migration 0001-0007과 `global_unowned_pre_phase1`만 검증한다.
- Phase 10 요구는 현재 0001-0024, 두 Workspace/RLS, logical restore, WAL PITR 증거다.
- 2026-07-25 manual rehearsal: PostgreSQL 17.10, 24 migrations, 74/74 tables,
  logical digest parity, named PITR, Workspace isolation, both clusters stopped.

## Remaining Risks

- 실제 Railway의 backup retention, regional recovery, platform rollback은 이 로컬 증거로
  대체할 수 없다.
