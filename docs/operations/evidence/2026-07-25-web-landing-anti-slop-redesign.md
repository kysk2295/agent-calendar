# Web landing anti-slop redesign evidence

- Date: 2026-07-25
- Plan: `docs/plans/2026-07-25-web-landing-anti-slop-redesign.md`
- Surface: `apps/web`

## Result

가짜 캘린더 DOM과 번호형 기능 목록을 제거하고 실제 Desktop QA 화면 세 장으로 제품
서사를 구성했다. 첫 화면은 일정 중심의 비대칭 split, 이후 화면은 Agent Work,
customer-controlled Runner, Wiki AI, Workspace 경계를 서로 다른 editorial layout으로
설명한다. 가입과 다운로드 availability는 기존 fail-closed handoff policy를 유지한다.

## TDD

1. `node --test apps/web/tests/anti-slop-landing.test.mjs`
   - RED: 실제 이미지, split hero, dark mode token이 없어서 3개 테스트 실패
   - GREEN: landing rewrite 후 3/3 통과
2. `npm --prefix apps/web test`
   - build 성공
   - 10/10 통과
3. `npm --prefix apps/web run lint`
   - 0 errors, 0 warnings
4. `git diff --check`
   - 통과

## Manual QA

Chrome에서 실제 로컬 Vinext surface를 열어 다음을 관찰했다.

- 1280 x 900 light: hero 높이 832px, 제목 2줄, `scrollWidth === clientWidth`
- 768 x 1024 light: CTA와 제품 프레임이 viewport 안에 유지됨
- 375 x 812 light: 제목 2줄, CTA와 제품 프레임이 잘리지 않고 수평 overflow 없음
- 1280 x 900 dark: 같은 deep-green accent와 neutral surface로 theme flip 없이 렌더링
- Wiki section까지 실제 스크롤 후 세 제품 이미지의 `naturalWidth` 확인
- `/privacy` route가 새 token system에서 정상 렌더링됨

처음 적용한 `next/image`는 Vinext 개발 런타임의 asset fetch 경계와 충돌해 overlay를
만들었다. 실제 QA에서 이를 발견했고 width, height, lazy loading을 지정한 정적 이미지로
교체해 overlay와 네트워크 오류를 제거했다.

## Artifacts

- `apps/web/test-results/anti-slop-landing/desktop-light.png`
- `apps/web/test-results/anti-slop-landing/tablet-light.png`
- `apps/web/test-results/anti-slop-landing/mobile-light.png`
- `apps/web/test-results/anti-slop-landing/desktop-dark.png`

## Remaining risk

현재 실제 제품 화면은 QA fixture Workspace를 사용한다. 공개 출시 직전 동일 layout과
실제 동작을 유지한 비식별 demo Workspace 캡처로 교체해야 한다.
