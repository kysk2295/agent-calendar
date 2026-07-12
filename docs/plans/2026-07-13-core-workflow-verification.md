# Core Workflow Verification

## Goal

실제 사용자 관점에서 일정 CRUD, 위키 질문과 출처, 에이전트 작업 실행과 결과, 새로고침 후 데이터 유지 흐름을 운영 Railway와 데스크톱 UI에서 끝까지 검증하고 발견한 결함을 수정한다.

## Non-goals

- 텔레그램 자동 보고와 스케줄러 제품화는 다음 우선순위로 남긴다.
- 운영 사용자의 기존 일정, 문서, 에이전트 실행 기록을 수정하지 않는다.
- 검증 편의를 위한 가짜 성공 상태를 UI에 추가하지 않는다.

## Work size

Large / Boundary. Desktop UI, Electron/Vite proxy, Railway gateway, persisted tasks/events/runs/wiki data를 함께 검증한다.

## Touched boundaries

- Backend gateway: `apps/backend/app/**`
- Desktop renderer: `apps/desktop/src/**`
- Electron proxy: `apps/desktop/electron/**`
- Tests: `apps/backend/tests/**`, `apps/desktop/tests/**`

## Success criteria

- 고유 QA 일정이 UI에서 생성, 수정, 완료되고 API에서도 동일하게 확인된다.
- 생성한 QA 데이터는 검증 후 삭제되어 운영 데이터가 남지 않는다.
- 위키 질문이 실제 답변과 한 개 이상의 근거 출처를 반환한다.
- 실제 Hermes 에이전트에 작업을 지시하고 실행 상태 또는 정직한 실패 상태를 확인한다.
- 페이지 새로고침 후 일정·위키·에이전트 상태가 서버 데이터와 일치한다.
- 발견한 결함은 RED 테스트 이후 수정되고 관련 전체 검증이 통과한다.

## Edge cases

- Railway 일부 리소스만 실패하는 부분 hydration
- 에이전트 runtime 또는 relay가 오프라인인 상태
- 위키 검색 근거가 부족해 답변을 만들 수 없는 상태
- QA 데이터 정리 요청이 실패하는 상태

## Test plan

- 실제 브라우저 UI로 주요 클릭과 입력을 수행한다.
- 각 저장 결과는 인증된 Railway API로 교차 확인한다.
- 새로고침 전후 DOM과 API 상태를 비교한다.
- 수정이 필요하면 가장 좁은 계약 테스트부터 추가한다.
- 마지막에 desktop tests, backend tests, build를 실행한다.

## Acceptance gates

- 실제 UI 일정 CRUD 및 정리
- 실제 위키 질문과 출처 확인
- 실제 에이전트 실행/실패 상태 확인
- 실제 새로고침 persistence 확인
- `npm test`
- `npm run build:desktop`

## Step-by-step checklist

- [x] 현재 운영 hydration과 콘솔 오류를 기준선으로 기록한다. (`api-banner=0`, `Railway 연결`, console warn/error 0)
- [x] 일정 생성·수정·완료·삭제 흐름을 실제 UI와 API에서 검증한다. (`QA-CORE-1783891817679`, 최종 잔여 0)
- [x] 위키 질문·답변·출처 열기 흐름을 검증한다. (UniPort 근거 3건, 출처 리더 본문 확인)
- [ ] 에이전트 선택·작업 지시·실행·결과 흐름을 검증한다.
- [ ] `POST /api/missions/launch`를 live Railway relay의 `runtime.request`로 전달하고 Mac mini run 응답을 보존한다.
- [ ] 새로고침 후 데이터 유지와 부분 실패 표시를 검증한다.
- [ ] 발견한 결함을 TDD로 수정한다.
- [ ] 전체 테스트와 빌드를 통과하고 QA 데이터를 정리한다.

## Rollback / fallback

- 모든 QA 레코드는 고유 접두사로 식별해 검증 후 삭제한다.
- 기능 수정은 실패한 경계에만 한정하며 기존 fallback 계약은 유지한다.

## Remaining risks

- 외부 Hermes runtime이 오프라인이면 실제 실행 완료 대신 정직한 실패 처리가 최종 기대 결과가 된다.
- Mac mini relay 인증은 복구됐지만 mission launch가 relay 대상에서 누락되어 `503 runtime_unavailable`을 반환한다.
