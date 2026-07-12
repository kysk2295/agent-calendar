# Railway And Obsidian Gap Closure

## Goal

운영 Railway의 부분 503과 과대 응답을 제거하고 최신 `main` 인증 계약을 실제 배포에 반영한다. 현재 실제 Obsidian 1.12.7 다크 그래프를 기준으로 Agent Calendar 그래프의 동작과 시각 차이를 측정 가능한 범위까지 줄인다.

## Non-goals

- 운영 데이터 삭제나 스키마 마이그레이션은 하지 않는다.
- 실제 Obsidian 볼트 데이터를 제품 코드에 하드코딩하지 않는다.
- 비교 점수를 위해 그래프를 정적 이미지로 대체하지 않는다.

## Work size

Large / Boundary. Railway gateway, Mac mini relay contract, Electron proxy, React graph rendering, deployment, 운영 검증을 함께 다룬다.

## Touched boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`, `apps/backend/app/lib/**`
- Desktop Electron: `apps/desktop/electron/**`
- Desktop renderer: `apps/desktop/src/**`
- Tests: `apps/backend/tests/**`, `apps/desktop/tests/**`
- Deployment/configuration: Railway and repository deployment configuration

## Success criteria

- 최신 `main` 배포가 운영 URL에서 식별되고 공개 API 인증 계약이 적용된다.
- 캘린더, inbox, automation, channels, dashboard 읽기 요청이 relay 부분 실패 때문에 모두 503이 되지 않는다.
- 자원별 API 응답이 동일한 전체 state를 반복 포함하지 않는다.
- Desktop hydration은 부분 실패를 표시하면서 성공한 데이터를 유지한다.
- 현재 Obsidian에서 직접 zoom 입력 전후 픽셀 변화가 증명된다.
- 동일 볼트, 동일 viewport, 동일 테마/카메라 상태의 fresh diff가 기록된다.
- 그래프 기능 테스트, 전체 테스트와 build가 통과한다.

## Edge cases

- relay snapshot은 살아 있지만 일부 Mac mini endpoint만 실패하는 경우
- client token이 없는 로컬 개발과 공개 Railway 환경
- 800개 이상의 노트와 수백 개 링크
- Obsidian 테마, 볼트 내용, 카메라 상태가 기준 캡처 이후 변한 경우
- 연결이 없는 선택 노트와 전체 그래프 상태

## Test plan

- 운영에서 실패한 각 GET route를 재현하는 gateway integration RED 테스트를 추가한다.
- compact resource response가 전체 state를 중복 포함하지 않는 계약 테스트를 추가한다.
- current-vault graph fixture로 노드/엣지/카메라/테마 Playwright 테스트를 추가한다.
- 동일 viewport fresh capture와 `visual-qa image-diff`를 매 반복마다 실행한다.
- 마지막에 `npm test`, `npm run build:desktop`, 운영 read-only API probe를 실행한다.

## Acceptance gates

- `npm run backend:check`
- `npm run test:backend`
- `npm --workspace apps/desktop run test`
- `npm run build:desktop`
- Railway 운영 endpoint read-only matrix
- Obsidian direct before/after interaction diff
- Current-vault same-size image diff

## Step-by-step checklist

- [x] Railway 배포 경로와 현재 운영 revision을 식별한다.
- [x] 부분 503의 relay/fallback 원인을 route별로 재현한다.
- [x] GET resource fallback과 compact response 계약을 구현한다.
- [x] 수정본을 Railway에 배포하고 인증/endpoint matrix를 재검증한다.
- [x] 현재 Obsidian 다크 그래프의 기준 상태와 직접 zoom 전후 픽셀 변화를 캡처한다.
- [x] 앱 그래프에 focus 전용 dark 상태와 1224x768 current-vault 프레임을 구현한다.
- [x] 노드 경계 고정, 라벨 크기, 프레임 차이를 A/B 반복한다.
- [x] 전체 자동 검증, graph Playwright, build와 운영 API QA를 통과한다.
- [ ] main 커밋/푸시 후 운영과 시각 diff를 최종 확인한다.

## Rollback / fallback

- relay resource fallback은 route별 기존 gateway store 응답으로 되돌릴 수 있게 유지한다.
- compact 응답은 기존 top-level canonical collection을 유지하고 중복 `state`만 제거한다.
- dark graph 변경은 focus mode에만 한정해 일반 앱 테마를 바꾸지 않는다.

## Remaining risks

- 운영 배포 `3a885e76-55f8-4ffe-af22-2306418385c4`는 성공했고 헬스체크 200, 무인증 보호 API 401, 인증 설정 API 200을 확인했다.
- 캘린더 응답은 약 2.15MB에서 186KB, inbox 응답은 약 980KB에서 118KB로 줄었지만 실제 항목 자체가 많아 100KB를 조금 넘는다.
- 현재 Obsidian 직접 zoom은 385,002 픽셀 변화로 동작이 증명됐다.
- 현재 다크 기준 동일 크기 diff는 33/100이다. 프레임과 그래프 밀도는 개선됐지만 Obsidian의 비결정적 force simulation 및 Electron 네이티브 크롬 차이 때문에 95% 픽셀 동기화는 아직 충족하지 못했다.
