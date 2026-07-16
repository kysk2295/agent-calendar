# Agent Calendar Design System

## 1. Product Tone

Agent Calendar is a calm productivity desktop app. The interface should feel like a focused workspace: warm, quiet, information-dense, and operational. Avoid marketing-page composition, decorative hero treatment, and saturated one-note palettes.

## 2. Color Tokens

- Canvas: `--canvas #EAE5DA`
- Main surface: `--main #F4F0E8`
- Top bar: `--bar #F7F3EB`
- Sidebar: `--sidebar #EFEADF`
- Panel: `--panel #FBF9F4`
- Input: `--input #FFFEFB`
- Line: `--line #E6DFD0`
- Strong line: `--line-strong #E0D8C8`
- Soft line: `--line-soft #EBE4D6`
- Text: `--text #2B2620`
- Muted text: `--muted #6E6253`
- Dark muted text: `--muted-dark #51483D`
- Accent: `--accent #D7613D`
- Accent dark: `--accent-dark #B8492C`
- Accent soft: `--accent-soft #FAEDE6`
- Accent line: `--accent-line #E4C3B5`
- Semantic green: `--green #3E9B72`
- Semantic blue: `--blue #5C77AD`
- Semantic lavender: `--lavender #7A66A7`
- Semantic amber: `--amber #9A6A20`
- Semantic amber soft: `--amber-soft #F5E9CF`
- Semantic red: `--red #B55245`
- Semantic red soft: `--red-soft #F6E3DF`

Theme variants may override these custom properties at `.app-root[data-theme]`. New UI should prefer the tokens above before adding fixed colors.

## 3. Typography

- Family: `Pretendard`, `Pretendard Variable`, `Apple SD Gothic Neo`, `-apple-system`, `system-ui`, `sans-serif`. The renderer exposes this order as `--font-sans`, so Electron remains legible when the optional CDN font is unavailable.
- Letter spacing: `0` for normal content.
- Navigation and dense controls use 10-12.5px text with 600-800 weight.
- Screen headings use roughly 15.5px and 700 weight.
- CJK copy must avoid cramped containers that create one-syllable or particle orphan lines.

## 4. Spacing And Radius

- Dense controls use 4-10px internal gaps.
- Panels use 12-18px padding depending on density.
- Repeated item and tool radii stay in the 6-10px range.
- Main panels may use 14px radius only when matching existing app shell surfaces.
- Use 1px borders for structure; reserve shadow for floating overlays, popovers, and primary floating actions.

## 5. Components

- Sidebar nav item: transparent base, `--accent-soft` active background, `--accent-line` active border.
- Panel: `--panel` background, `--line-soft` border, restrained radius.
- Popover/settings panel: near-white warm surface, compact sections, subtle shadow, scrollable when content overflows.
- Icon button: square, stable dimensions, clear hover/active state. Use SVG icon shapes where available; text glyphs are acceptable only for existing legacy controls until the icon system is introduced.
- Graph canvas: light warm background, small neutral nodes, subdued links, active node with warm accent ring, settings/actions as overlaid controls.
- Agent control room reference: `apps/desktop/prototypes/agent-tab.html` remains a visual-density reference only. The app reuses the existing global sidebar and warm tokens; its obsolete drawer navigation is not an interaction contract.
- Native desktop shell: the primary Electron app keeps the sidebar and desktop content shell at every supported window size. Mobile bottom navigation and a mobile-only app shell are not supported; feature-level reflow may still protect accessibility at high zoom without replacing the desktop navigation model.
- Control Home: shown only while no Delegated Work is selected. It contains the compact status summary, natural-language delegation entry, attention/recent-work navigation, and existing routine/automation cards. Selecting a work card replaces Control Home with that work's primary workspace; Back restores Control Home. Successful creation auto-opens the created work.
- Control Home cards: Delegated Work cards are navigational and expose a text status plus the next meaningful action. Routine and automation cards remain read-only summaries on Control Home: they may reveal truthful schedule/owner/last-run details, but they do not open a Work Conversation and expose no create, edit, delete, run, or approval control in this scope. Missing runtime fields use `확인 필요`; the UI never invents success.
- Primary Work Conversation workspace: one selected Delegated Work occupies the normal main content region, not an overlay, drawer, scrim, modal, or board-underlay. Its header provides Back, title, text status, Responsible Agent, and current attention/next-action summary. The execution engine, Task Session, budget, schedule, policy, plan, artifacts, and raw runtime metadata are secondary details and must not displace the conversation.
- Work Conversation timeline: one centered, chronological stream begins with the original delegation and continues through user/agent messages and user-meaningful Work Checkpoints. A checkpoint exposes timestamp, plain-language title and state, concise body, relevant artifact/evidence links, and only actions valid for that state. Plan, approval request/response, progress, blocked, error, completion, and `수정 차수` markers share this chronology. Raw tool calls, chain-of-thought, secrets, private paths, heartbeats, and repetitive runtime logs never appear as primary messages.
- Secondary details: at wide widths a quiet adjacent rail may show plan, artifacts, Responsible Agent, requested execution engine, optional actual resolved engine, schedule, policy, budget, and optional Task Session entry. It is subordinate in contrast and reading order, collapses to a labeled disclosure before it can compress the timeline, and never becomes a parallel report surface. The result identified by `currentResultReportId` remains the single current completion checkpoint; earlier results remain visible during later `수정 차수` attempts. A missing actual resolved engine is shown as unknown, never inferred from the request.
- Delegation and work composers: Control Home creates work directly from natural language without requiring an internal mission title, deliverable kind, file format, Responsible Agent, or execution engine. The selected-work composer is always available while the workspace is readable, including before planning and while loading older history, blocked, failed, completed, approval-required, or during a `수정 차수`. Agent and engine overrides, when supported, live under secondary advanced options at delegation rather than the primary path. Existing-work Responsible Agent reassignment is not exposed in this release.
- Delivery feedback: every submitted message remains visible and receives one truthful durable delivery label and copy. The core Korean status labels are `accepted` = `접수됨`, `applied` = `적용됨`, `queued` = `다음 시도에 반영 예정`, `approval_required` (approval-required) = `승인 필요`, and `rejected` = `실행할 수 없음`. For `accepted`, `applied`, and `rejected`, the durable copy may append the truthful application-mode qualifier after ` · ` before its explanation (for example, `접수됨 · 작업 대화에 저장 — 작업 대화에 저장되었습니다.`); `next_checkpoint` may instead use the explicit `다음 체크포인트 적용 요청됨` label. `queued` remains `다음 시도에 반영 예정 — 현재 실행은 중단하지 않습니다.` and `approval_required` remains `승인 필요 — 승인 전에는 실행되지 않습니다.` Never use `applied` for a merely stored or queued message.
- Approval checkpoint: exists only for an already-supported consequential action and names the proposed consequence, scope, and Responsible Agent before providing explicit approve/reject actions. Approval-required work remains paused until approval. Unsupported external send, publish, purchase, or delete requests are rejected/blocked checkpoints without a misleading approval button.
- State contract: loading preserves the workspace header, Back, and composer, marks the timeline busy, and uses no fabricated checkpoint; initial empty shows the original request or an explicit `아직 체크포인트가 없습니다` message plus the enabled composer; recoverable error preserves selected work and draft, explains what failed, and offers retry; blocked states name the blocker and safe next action; completed states identify the result selected by `currentResultReportId` and invite a same-outcome `수정 차수`; `수정 차수` states insert `수정 차수 N 시작/완료` markers, keep prior results chronological, and label exactly one result current. No state becomes a blank panel or removes the path back.
- Responsive contract: at 1280px the centered conversation is the dominant column with an optional secondary details rail; at 768px the conversation keeps full reading priority and details collapse into an in-flow disclosure; at 375px the workspace is one column, actions wrap without truncating Korean copy, and the in-flow composer never covers timeline content. At 200% zoom, apply the same narrow reflow instead of shrinking type: one scroll owner, no horizontal page overflow, no off-screen action, and details remain reachable in document order.
- Task Session: remains an optional execution detail reached from secondary details. It does not replace the Work Conversation or become a second user-facing result path; its existing transcript and contract may retain technical Mission/Task Session terms inside that advanced context.

## 6. Motion

- Motion must communicate interaction or state changes.
- Use short transitions around 120-180ms for hover, opacity, and transform.
- Graph animations may run longer only when representing timeline/playback, zoom, pan, or graph settling.
- Respect `prefers-reduced-motion: reduce`: remove non-essential spatial transitions, smooth scrolling, shimmer, and checkpoint-entry motion; use immediate state changes while preserving focus and live-region feedback. No primary workspace transition depends on motion for meaning.

## 7. Accessibility

- Interactive controls require accessible names.
- Fixed-format controls such as graph buttons, sliders, and node targets need stable dimensions.
- Focus states must remain visible through native or app-specific focus outlines.
- Graph controls must remain keyboard-operable for zoom reset and view navigation.
- Agent status must never rely on color alone; every calendar item, row, and transcript state includes a visible text label.
- Task Session messages and actions use live-region feedback, visible focus states, and explicit `next checkpoint` wording for non-interruptible running work.
- The Agent Work composer supports `Enter` to submit and `Shift+Enter` for a new line. Send, new-work, session-open, and status actions have accessible names and stable target dimensions.
- Work cards are reachable and activatable by keyboard. Opening existing work or auto-opening newly created work moves focus to the Work Conversation heading without skipping the Back control in tab order. Back restores focus to the originating card or creation control; if that target no longer exists, focus moves to the Control Home recent-work heading.
- Delivery feedback is announced through a polite live region without moving focus. Approval and blocker checkpoints use descriptive headings and explicit action labels; completed and `수정 차수` states never rely on color, animation, or relative position alone.
- The warm surface hierarchy uses the existing `--canvas`, `--main`, `--panel`, `--input`, `--line*`, `--text`, `--muted*`, and semantic tokens. Do not introduce a cold parallel palette for Work Conversation; status color is always paired with text, and shadow remains reserved for genuinely floating secondary UI rather than the in-flow workspace.

## 8. Accepted Debt

- The existing desktop app keeps much of the UI in `apps/desktop/src/App.tsx` and `apps/desktop/src/styles.css`. New work should stay scoped and avoid broad visual refactors unless the user explicitly asks for a component-system extraction.
