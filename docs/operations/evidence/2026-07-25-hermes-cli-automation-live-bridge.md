# Hermes CLI Automation Live Bridge evidence

- Date: 2026-07-25
- Plan: `docs/plans/2026-07-25-hermes-cli-automation-live-bridge.md`
- Installed Hermes: `v0.18.2`

## Result

Runner에 endpoint 설정이 없으면 설치된 `hermes cron` CLI를 사용한다. create는 항상
`--deliver local`로 실행하고 새 작업을 바로 pause한다. edit, pause, resume, run은 exact
external id를 사용한다. CLI가 반환하지 않는 goal과 agent assignment는 Gateway의 기존
Workspace record에서 보존한다.

Provider mutation 전 Runner local journal에 started 상태를 기록하고, provider 결과는
Gateway complete보다 먼저 completed journal에 기록한다. 완료 전 transport 단절은 같은
result를 replay하고, started 상태만 남은 불명확한 요청은 provider를 다시 호출하지 않고
`SOURCE_OUTCOME_UNKNOWN`으로 종료한다.

Gateway는 stale running connector request를 설정된 lease 이후 같은 Workspace와 같은
Runner에게만 다시 제공한다. Runner private state는 owner-only temporary file을 같은
directory에서 rename하는 방식으로 원자적으로 교체한다.

## TDD and gates

- `node --test apps/runner/tests/provider-connectors.test.cjs`: 17/17
- `node --test apps/runner/tests/runner-client.test.cjs`: 6/6
- `node --test apps/backend/tests/phase7-automation-federation.test.cjs`: 7/7
- `npm run backend:check`: pass
- `npm --workspace apps/runner run check`: pass
- `npm run typecheck`: pass
- `npm test`: backend, Desktop 281/281, Runner 51/51 pass before the atomic store step
- `npm --workspace apps/runner test`: Runner 52/52 pass after the atomic store step

추가 RED에서 HTTP create가 구형 `/api/cron/jobs`를 사용하는 실패를 확인했다. 설치된
Gateway source의 `POST /api/jobs` 계약으로 수정하고 create 후 exact id pause까지
테스트했다.

## Live installed Hermes lifecycle

기존 scheduled job이 0개인 상태에서 고유 이름의 임시 job 하나만 사용했다.

- create: exact id `b07df8a0e145`, paused, `deliver=local`
- list: public name, schedule, status, next run만 projection
- edit: name, prompt, schedule 변경 관찰
- resume, pause, resume: 상태 전환 관찰
- run: last status `ok`와 last run timestamp 관찰
- cleanup: `hermes cron remove b07df8a0e145`
- final inventory: `No scheduled jobs`

Gateway credential, Hermes credential, script, workdir, host path는 evidence나 connector
response에 포함하지 않았다.

## Remaining risk

Hermes에는 provider-global idempotency key가 없다. provider 성공과 local completed journal
기록 사이에 process가 강제 종료되면 결과를 자동 추정하거나 중복 실행하지 않고
`SOURCE_OUTCOME_UNKNOWN`으로 표시한다.
