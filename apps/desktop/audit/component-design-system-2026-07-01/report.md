# Component Design-System Audit

Date: 2026-07-01
Reference: `/Users/koyunseo/Downloads/hermes-os-desktop-app 3/project/Hermes Tasks.dc.html`

## Captured Steps

1. `00-new-task-focused-title.png` - 새 작업 팝오버, 제목 input 자동 포커스
2. `01-new-task-date-picker.png` - 새 작업 팝오버, 날짜 피커 열림
3. `02-new-task-duration-picker.png` - 새 작업 팝오버, 지속 시간 모드
4. `03-task-detail-modal.png` - 작업 상세 모달
5. `04-delegate-modal.png` - 에이전트 위임 모달
6. `05-settings-overlay.png` - 설정 오버레이

Computed values are saved in `component-metrics.json`.

## Fixed In This Pass

1. New-task cancel button
   - Problem: `취소` button looked like a browser/default button instead of the Hermes system button.
   - Reference target: `height: 30px`, `background: #FBF9F4`, `color: #8A8070`, `border: 1px solid #E0D8C8`, `border-radius: 8px`, `font-size: 12px`, `font-weight: 600`.
   - Current verified value: matches the reference target.

2. New-task confirm button
   - Problem: footer button styling was not explicitly scoped, so it could drift from the original popover system.
   - Reference target: `height: 30px`, `background: #D7613D`, white text, no border, `border-radius: 8px`, `font-size: 12px`, `font-weight: 700`.
   - Current verified value: matches the reference target.

3. New-task list selector
   - Problem: it was treated too much like a button, while the reference uses a text/chip-like control.
   - Fix: explicit text-chip sizing, transparent background, 7px radius, 12px/600 type, hover background `#F3EEE2`.

4. New-task title input
   - Problem: current font weight was `700`; reference uses `600`.
   - Fix: set `font-weight: 600` and `letter-spacing: -0.01em`.

5. New-task date chip state
   - Problem: `날짜 추가` was always terracotta/red. In the reference, empty date state is muted gray and selected date state is red.
   - Fix: added `data-has-date` and scoped color state.
   - Current verified empty state: `rgb(154, 144, 128)` / `#9A9080`.

6. Borderless input focus typography
   - Problem: global `input:focus` added a terracotta box shadow to borderless fields. This made the new-task title field look like a default bordered input and changed the perceived typography.
   - Reference target: borderless title/description/search inputs should keep `outline: none`, transparent background, no border, and no focus shadow.
   - Current verified new-task title: `14.5px`, `font-weight: 600`, `border: 0`, `box-shadow: none`.

7. Settings logout button
   - Problem: `로그아웃` in settings could render like a default system button.
   - Reference target: `height: 32px`, `background: #FBF9F4`, `color: #C0533B`, `border: 1px solid #E4CBC2`, `border-radius: 8px`, `font-size: 12px`, `font-weight: 600`.
   - Current verified value: matches the reference target.

## Still Noted

- The popover is visually faithful in tokens and controls, but the content can scroll at the captured viewport because the panel uses the original `max-height: 74vh`.
- The wider task detail modal is consistent with existing React implementation, but should be compared against the exact original detail-modal state if that screen must be pixel-locked too.
- Some broader product structure differences remain from the previous audit: live Railway taxonomy currently replaces the original sidebar list defaults. That is an information-architecture issue, not just a CSS issue.

## Verification

- `npm run build` passed.
- `npm test` passed.
- `./node_modules/.bin/electron tests/ui-smoke.cjs` passed.
- Electron component capture passed and produced screenshots plus `component-metrics.json`.
