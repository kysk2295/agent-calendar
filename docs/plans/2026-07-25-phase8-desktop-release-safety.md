# Plan: Phase 8 Desktop Release Safety

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Complete
- Parent: `docs/plans/2026-07-24-production-development-roadmap.md`

## Goal

Desktop이 새 stable 버전을 안전하게 확인·다운로드·설치할 수 있고, 렌더러 충돌 뒤
Workspace 보관본을 유지한 채 자동 복구하되 반복 충돌에서는 무한 재시작 대신 안전
화면으로 멈춘다. macOS 릴리스 후보는 DMG/ZIP, 업데이트 메타데이터, SHA-256, SBOM,
provenance를 생성하는 draft Release workflow를 갖는다.

## Non-Goals

- Developer ID Application 인증서와 Apple notarization credential 자체 발급
- 이번 로컬 검증에서 실제 공개 GitHub Release 생성 또는 stable 승격
- Runner 자체 업데이트
- 업데이트 중 DB/API schema migration
- Web 다운로드 랜딩 또는 Mobile 배포

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: release status/check/download/install, crash recovery status
- React UI: 설정의 간결한 업데이트 상태와 복구 알림
- Packaging/CI: electron-builder GitHub provider, staged manifest, signed/notarized draft workflow
- Tests: updater/crash 순수 테스트, release contract, Electron crash/update surface ETE
- Docs: 이 계획, roadmap Phase 8, 운영 evidence

## Success Criteria

- [x] stable 앱은 prerelease/downgrade를 허용하지 않고 사용자가 요청할 때만 업데이트를
      다운로드·설치한다.
- [x] 업데이트 상태는 확인 중, 최신, 사용 가능, 다운로드, 설치 준비, 오류를 정직하게
      표시하고 URL·token·raw updater 오류를 renderer에 노출하지 않는다.
- [x] 중복 확인/다운로드를 합치고 허용되지 않은 상태의 설치를 거부한다.
- [x] 렌더러 첫 두 번의 비정상 종료는 자동 복구하며 복구 사실과 보관본 확인 안내를
      실제 제품에 표시한다.
- [x] 5분 내 세 번째 비정상 종료는 무한 reload 대신 packaged safe-recovery 화면을
      표시하고 사용자가 명시적으로 다시 열 수 있다.
- [x] 공개 릴리스 workflow는 macOS arm64 DMG/ZIP, update manifest, blockmap, SHA-256,
      CycloneDX SBOM, GitHub provenance를 draft Release에만 올린다.
- [x] staged percentage가 1–100 범위를 벗어나거나 package version과 release version이
      다르면 릴리스를 중단한다.
- [x] Developer ID/notarization secret이 없으면 공개 release job은 fail closed한다.
- [x] main/overlay renderer는 신뢰되지 않은 navigation·redirect를 막고 모든 preload IPC를
      신뢰된 packaged renderer 또는 고정된 dev origin으로 제한한다.

## Edge Cases

- 개발/비패키지 앱에서 update 확인
- check 또는 download 중 버튼을 반복해서 누름
- update provider 404/5xx 또는 잘못된 manifest
- prerelease가 stable 앱에 노출됨
- 다운로드 완료 전 앱 종료
- renderer `oom`, `crashed`, `integrity-failure`, `clean-exit`
- 충돌 후 cache restore와 Gateway offline이 동시에 발생
- safe-recovery 화면 자체를 사용자가 다시 열음

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] updater state manager가 없어 check/download/install 상태 테스트가 실패한다.
  - [x] crash circuit breaker가 없어 반복 충돌 테스트가 실패한다.
  - [x] release workflow와 update metadata 설정이 없어 contract test가 실패한다.
  - [x] 산출물 이름 불일치와 untrusted renderer 이동/IPC 계약 테스트가 실패한다.
- GREEN:
  - [x] injected updater adapter와 최소 release state manager를 구현한다.
  - [x] bounded renderer recovery controller와 packaged fallback page를 구현한다.
  - [x] main/preload/UI 연결과 fake updater/crash Electron ETE를 구현한다.
  - [x] draft release workflow와 rollout manifest tool을 구현한다.
  - [x] 실제 builder 산출물·metadata 이름을 통일하고 renderer trust guard를 적용한다.
- REFACTOR:
  - [x] App에는 release/recovery presentation만 두고 runtime policy는 Electron 모듈에 둔다.

## Acceptance Gates

- [x] Desktop release manager tests
- [x] Desktop crash recovery tests
- [x] Release workflow/config contract tests
- [x] Actual Electron update status ETE
- [x] Actual Electron crash/recovery/fallback ETE
- [x] Actual Electron untrusted renderer navigation ETE
- [x] Local macOS arm64 DMG/ZIP + update manifest inspection
- [x] `npm run backend:check`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Light/dark recovery and settings surface review
- [x] Independent read-only release/security review

건너뛴 gate:

- Public Developer ID notarization and GitHub draft release:
  - Reason: 현재 host에는 Apple Development identity만 있으며 Developer ID Application,
    notarization API key, GitHub release environment 승인이 없다. workflow는 fail closed로
    구현하고 실제 credential gate는 외부 릴리스 관문으로 남긴다.

## Implementation Checklist

- [x] Step 1: 현재 release/crash truth 감사와 정책 고정
- [x] Step 2: updater/crash/release contract RED
- [x] Step 3: Electron release manager와 recovery controller GREEN
- [x] Step 4: IPC/preload/Settings/recovery UI GREEN
- [x] Step 5: draft release workflow와 rollout tooling
- [x] Step 6: Electron ETE와 로컬 패키지 검증
- [x] Step 7: full gates, reviewer, evidence, roadmap

## Rollback

- updater 초기화와 IPC를 feature-disabled 상태로 되돌리면 기존 수동 배포 앱으로
  돌아간다.
- crash controller를 제거하면 기존 1회 reload 동작으로 되돌릴 수 있으나 반복 충돌
  보호를 잃는다.
- promoted stable manifest는 덮어쓰지 않는다. ADR 0009대로 known-good commit에서 더
  높은 patch version을 만들어 rollout을 재개한다.

## Verification Notes

- `node --test` release/trust/proxy/deep-link focused suite: 18/18 passed
- `npm --workspace apps/desktop run test`: 243/243 passed
- `npm test`: backend 410/410, Desktop 243/243, Runner 19/19 passed
- `npm run build:desktop`: passed
- Electron renderer trust ETE:
  - HTTPS와 임의 local file navigation이 모두 차단됨
  - packaged renderer URL과 guarded preload bridge가 유지됨
- Electron release/crash ETE:
  - light/dark 모두 update-ready, restart restore, third-crash safe recovery 통과
- Local package:
  - `Agent-Calendar-0.1.0-arm64.dmg` 133,683,437 bytes
  - `Agent-Calendar-0.1.0-arm64.zip` 131,338,269 bytes
  - builder files와 `latest-mac.yml` path가 동일한 이름을 사용
  - finalizer와 `shasum -a 256 -c SHA256SUMS` 통과
- Independent remediation review:
  - reviewer: `phase8_offline_review`
  - reviewed HEAD: `16d59256801d822e3430cdd30eaa7b56d58ecab9`
  - verdict: `PASS / APPROVE`
  - focused recheck: 13/13 passed
  - report: `.omo/evidence/phase8-desktop-release-safety-remediation-review.md`

## Remaining Risks

- 실제 macOS update 설치는 서로 다른 두 Developer ID notarized 버전이 있어야 완전
  검증할 수 있다.
- GitHub staged percentage는 manifest 기반 배포 선택이며 release 승격 운영 권한을
  대체하지 않는다.
