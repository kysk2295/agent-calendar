# Hermes Tasks Design-System Audit

Date: 2026-07-01
Viewport: Electron hidden window, 1320 x 824 app window, captured content 1320 x 796

## Evidence

- Current calendar: `01-current-calendar.png`
- Current wiki graph: `02-current-wiki-graph.png`
- Current new task modal: `03-current-new-task-modal.png`
- Original reference HTML: `04-reference-original-html.png`
- DOM metrics: `metrics.json`
- Reference file: `/Users/koyunseo/Downloads/hermes-os-desktop-app 3/project/Hermes Tasks.dc.html`

## Verdict

The current app follows the original design system at the core token and layout level, but it is not a perfect fixed reproduction of the original HTML screen.

Preserved:
- Sidebar width is 248px.
- Topbar height is 52px.
- Base background, sidebar, panel, border, and accent palette match the original beige/terracotta system.
- Pretendard stack is applied.
- Calendar density, small labels, badge styling, and compact topbar shape are close to the original.
- Wiki graph now exists as a large graph panel and uses real Railway graph data.

Not Fully Preserved:
- Sidebar list/tag content no longer matches the original reference defaults. The original shows Study, 대학교, 투자, Side Projects, crypto trading, 비즈니스, UniPort, Me, 생각노트, 언젠가, plus tag chips. The current app shows Railway-derived taxonomy, currently mainly TickTick Import and an empty tag create action.
- Dynamic taxonomy grouping works functionally, but group headings can become `리스트 · 가져온 항목`, which is not visually identical to the original simple `리스트` section.
- New task modal is compact and functional, but its visual hierarchy is simpler than the original detailed add-task popover system.
- Wiki graph intentionally diverges from the beige panel interior by using an Obsidian-like dark canvas. This matches the later user request, but it is a feature-specific exception to the original palette lock.

## Main Risk

The largest mismatch is not spacing or color. It is information architecture in the sidebar. If the acceptance criterion is "original HTML exactly, but backed by real data", then the app should keep the original sidebar sections and allow those lists/tags to be real Railway-backed entities instead of disappearing when the backend only has TickTick import data.

## Recommended Fix

Make the original sidebar taxonomy the default Railway-backed seed:

- Seed or upsert the original list groups on first launch: Study, 대학교, 투자, Side Projects, crypto trading, 비즈니스, UniPort, Me, 생각노트, 언젠가.
- Seed tags: 업무, 주식, Blue, Red, 인생.
- Keep TickTick imported lists/events as imported children or a separate import bucket, not as a replacement for the original visible taxonomy.
- Keep user-created list/tag grouping, but render top-level section titles exactly as the original unless a custom group is explicitly created.

This would preserve the original design while still supporting real creation, grouping, tagging, and Railway persistence.
