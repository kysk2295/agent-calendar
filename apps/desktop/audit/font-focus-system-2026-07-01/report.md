# Font And Focus System Audit

Date: 2026-07-01
Reference image: `/Users/koyunseo/.codex/attachments/23b10710-3ca5-49f3-87ec-d077e3841012/image-1.png`
Reference HTML: `/Users/koyunseo/Downloads/hermes-os-desktop-app 3/project/Hermes Tasks.dc.html`

## Scope

Automated Electron scan across 17 rendered states:

- Calendar
- New task focused title state
- Today
- Next 7 days
- Inbox/default list
- Task detail
- Delegate modal
- Mail
- Kanban
- Notes
- Weekly review
- Wiki
- Diary
- Agents
- Search
- Settings overlay
- Chat drawer

Skipped: none.

## Fixed In This Pass

1. Removed global focus shadow from inputs and textareas.
   - Problem: the app applied a terracotta focus box to every input.
   - Why it was wrong: original `Hermes Tasks.dc.html` only uses `outline: none` for focused inputs/textareas. Borderless fields must stay visually borderless.
   - Current verified result: no focused input/textarea/select in the scanned states has non-`none` box-shadow.

2. Kept new-task title typography clean.
   - Current verified result: `14.5px`, `font-weight: 600`, transparent background, `border: 0`, `box-shadow: none`.

3. Normalized diary timeline button typography.
   - Problem: timeline row buttons inherited browser-ish `16px / 400` as their container style.
   - Fix: explicit Hermes list text baseline on `.diary-timeline button`.

4. Kept settings logout button in Hermes style.
   - Current verified result: `height: 32px`, `#FBF9F4` background, `#C0533B` text, `#E4CBC2` border, `8px` radius, `12px / 600`.

5. Removed outlier `900` font weights.
   - Problem: the original HTML uses `800` as its strongest common emphasis, while the React CSS had two `900` outliers.
   - Fix: changed wiki bullet emphasis and detail checkmark emphasis from `900` to `800`.

6. Static typography cleanup check.
   - Current verified result: no `font-weight: 900`, no negative `letter-spacing`, and no focus-shadow rule remain in `src/styles.css` or `src/App.tsx`.

7. Restored fixed notes navigation.
   - Problem: when Railway/imported taxonomy had no plain `리스트` group, the original fixed `생각노트`/`언젠가` entries could disappear from the sidebar.
   - Fix: always add the original fixed `리스트` group if it is absent.
   - Current verified result: the scanner covers `생각노트` and UI smoke reports `📝생각노트5` in the sidebar.

## Automated Findings

Saved file: `scan-results.json`

- `focus-shadow-leak`: 0
- `font-family-leak`: 0
- `native-button-leak`: 0
- Total issue count: 0
- Static outlier check: 0 matches for `font-weight: 900`, negative `letter-spacing`, or focus box-shadow rules.
- Skipped rendered states: 0

## Verification

- `npm run build` passed.
- `npm test` passed.
- `./node_modules/.bin/electron tests/ui-smoke.cjs` passed.
- `./node_modules/.bin/electron audit/font-focus-system-2026-07-01/scan.cjs` passed with `issueCount: 0`.
