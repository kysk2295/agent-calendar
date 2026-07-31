# Production disaster recovery

## 목적

이 런북은 Agent Calendar의 현재 PostgreSQL 스키마가 백업에서 실제로 복구되고,
복구본에서도 Workspace 격리가 유지되는지 확인하는 절차다.

로컬 리허설은 다음 두 경로를 모두 검증한다.

1. migration `0001`부터 현재 최신 migration까지 적용한 DB의 논리 dump/restore
2. physical base backup과 archived WAL을 이용한 이름 있는 restore point 복구

이 절차는 Railway 운영 DB에 접속하지 않는다. 관리형 백업 보존 기간, 운영 RPO/RTO,
리전 장애 복구는 Railway 프로젝트에서 별도로 증명해야 한다.

## 안전 경계

- `DATABASE_URL` 또는 원격 DB 주소를 인자로 받지 않는다.
- 비어 있는 전용 임시 디렉터리만 작업 경로로 허용한다.
- 실제 사용자 데이터 대신 두 개의 합성 Workspace fixture만 사용한다.
- source와 recovery PostgreSQL 프로세스가 모두 중지된 뒤에만 `ok: true`를 출력한다.
- evidence에는 연결 문자열, 사용자 절대 경로, row payload, credential 값이 들어가지 않는다.

## 준비 사항

- PostgreSQL 16 또는 17
- `initdb`, `pg_ctl`, `postgres`, `psql`, `pg_dump`, `pg_restore`, `pg_isready`,
  `pg_basebackup`
- 선택한 PostgreSQL major version과 호환되는 pgvector extension

Homebrew PostgreSQL 17을 명시하려면 `PHASE10_PG_BIN`에 해당 `bin` 디렉터리를 설정한다.

## 실행

저장소 루트에서 비어 있는 전용 임시 디렉터리를 만든 뒤 실행한다.

```sh
PHASE10_RECOVERY_DIR="$(mktemp -d /tmp/agent-calendar-recovery.XXXXXX)"
node apps/backend/tools/phase10-disaster-recovery-rehearsal.cjs \
  --work-dir "$PHASE10_RECOVERY_DIR"
```

검토 가능한 redacted evidence를 갱신할 때만 `--write-evidence`를 추가한다.

```sh
node apps/backend/tools/phase10-disaster-recovery-rehearsal.cjs \
  --work-dir "$PHASE10_RECOVERY_DIR" \
  --write-evidence
```

한 번 사용한 디렉터리는 다시 입력으로 사용할 수 없다. 생성된 dump, base backup, WAL,
로그를 확인한 뒤 그 정확한 임시 디렉터리만 삭제한다.

## 성공 판정

출력 JSON에서 다음 조건이 모두 참이어야 한다.

- `ok`
- `logical.matchesSource`
- `pitr.safeMarkerPresent`
- `pitr.damageMarkerAbsent`
- `pitr.workspaceIsolation`
- `clustersStopped`

`expectedTables`는 migration 파일에서 동적으로 계산된다. source나 restore에 누락 또는
예상 밖의 public table이 있으면 실패한다. 논리 복구는 각 table의 row count와
row digest까지 source와 같아야 한다.

PITR은 `phase10_before_accidental_delete`라는 경계 이름을 기록하고, 그 직후 확인한
정확한 WAL LSN을 복구 target으로 사용한다. 누적 archive count가 아니라 해당 LSN을
포함하는 정확한 WAL filename이 archive에 도착할 때까지 기다린다. PostgreSQL이
`pg_isready`에 응답하는 것만으로 복구 완료를 추정하지 않으며,
`pg_is_in_recovery() = false`로 promotion을 확인한 뒤에만 복구 row를 조회한다.
restore boundary 전에 추가한 안전한 task는 살아 있어야 하고, 그 뒤 삭제한 task와
damage marker는 복구본에 남아 있으면 안 된다. `agent_calendar_app` role로 조회했을 때
각 Workspace는 자기 task만 볼 수 있어야 한다.

## 실패 시

- `postgresql_disaster_recovery_binaries_missing`: 필요한 PostgreSQL binary를 설치하거나
  `PHASE10_PG_BIN`을 올바른 major version으로 지정한다.
- `vector_extension_unavailable`: 선택한 PostgreSQL major와 일치하는 pgvector를 설치한다.
- `logical_restore_verification_failed`: migration 목록과 table mismatch를 확인한다.
- `wal_archive_timeout`: archived WAL이 restore point 이후까지 도착하는지 확인한다.
- `pitr_verification_failed`: 복구 지점, safe marker, damage marker, Workspace 격리 결과를
  확인한다.
- `clustersStopped: false`: 성공으로 취급하지 말고 해당 임시 경로의 postmaster를 먼저
  중지한다.

민감한 실제 값은 incident 문서에 복사하지 않는다. 상세 원인은 임시 작업 경로의
PostgreSQL 로그에서만 확인한다.

## 운영 배포 전 추가 관문

이 로컬 리허설만으로 운영 복구 준비가 끝난 것은 아니다. 공개 가입 전에는 별도로:

1. Railway 관리형 backup retention과 PITR 보존 범위를 기록한다.
2. 운영 snapshot을 격리된 비운영 DB로 복원하되 사용자 데이터 노출 통제를 적용한다.
3. 실제 RPO/RTO를 측정하고 incident owner를 지정한다.
4. blue-green Gateway rollback과 Runner binary rollback을 관찰한다.
5. 복구본의 `/api/ready`, Workspace 격리, Calendar, Agent Work, Automation smoke를 통과한다.

현재 로컬 증거는
`docs/operations/evidence/2026-07-25-phase10-disaster-recovery.json`에 있다.

## Current-schema repository completion evidence

`local-current-schema-ops-dr-qa.cjs` composes this PostgreSQL rehearsal with the local Gateway and
Runner rollback evaluators. Its expected migration inventory is read from disk on every run; the
latest file is never pinned to a migration number. Each migration has a SHA-256 digest, and the
result is bound to the exact Git source SHA and a bounded observation window.

The current fixture restores two non-identifying Workspace sentinels and queries the recovery
database for Calendar, Delegated Work, Connected Automation, and Runner rows. Evidence exposes
only two distinct Workspace fingerprints and booleans for the critical domains, never the raw
rows, identities, connection strings, socket paths, or credentials. Local RPO/RTO values are
explicitly labeled `local_only`.

This repository result is not managed-backup evidence. Full Todo 17 remains incomplete until an
authorized Railway/managed snapshot and PITR restore is performed into an approved isolated
target, external RPO/RTO is measured, restore access and data handling are reviewed, and temporary
restore cleanup has an approved and observed receipt. The local script neither reads nor mutates a
real database and must not be presented as Railway restore evidence.
