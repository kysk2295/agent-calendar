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

- Family: `Pretendard`, `Pretendard Variable`, `-apple-system`, `system-ui`, `sans-serif`.
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
- Agent Operations tabs: compact three-option tab row with a 1px structural divider and accent underline on the active view.
- Mission contract: unframed two-column operational layout. The mission list is a compact selectable list; objective, budget, cadence, sources, policy, and work plan occupy a structured detail region without nested cards.
- Agent work row: fixed-height task row with agent, reason, expected output, schedule, and status. `proposed` uses amber plus a dashed line; `scheduled` and `running` use blue; `completed` uses green; `blocked` and `failed` use red.
- Mission live summary: an unframed status band above the work area. It shows mission state, completed-task progress, current or next task, and the responsible Hermes profile. It must answer "what is happening now" without opening another view.
- Work timeline: a vertical ordered list with a stable status marker and connector line. Each row exposes schedule, expected duration, expected output, and explicit commands. `세션 열기` is always visible when a Task Session exists; `지금 실행` is the primary command for scheduled work.
- Mission context rail: budget, report cadence, allowed context, success criteria, and forbidden actions remain visible as secondary operational context. On narrow screens the work timeline precedes this rail.
- Task Session: full-height three-column workspace with sibling sessions, ordered transcript, and task contract. At narrow widths it becomes one column in the order session list, transcript, contract. The message composer remains visible without covering transcript content.

## 6. Motion

- Motion must communicate interaction or state changes.
- Use short transitions around 120-180ms for hover, opacity, and transform.
- Graph animations may run longer only when representing timeline/playback, zoom, pan, or graph settling.
- Respect reduced-motion preferences for non-essential animation.

## 7. Accessibility

- Interactive controls require accessible names.
- Fixed-format controls such as graph buttons, sliders, and node targets need stable dimensions.
- Focus states must remain visible through native or app-specific focus outlines.
- Graph controls must remain keyboard-operable for zoom reset and view navigation.
- Agent status must never rely on color alone; every calendar item, row, and transcript state includes a visible text label.
- Task Session messages and actions use live-region feedback, visible focus states, and explicit `next checkpoint` wording for non-interruptible running work.

## 8. Accepted Debt

- The existing desktop app keeps much of the UI in `apps/desktop/src/App.tsx` and `apps/desktop/src/styles.css`. New work should stay scoped and avoid broad visual refactors unless the user explicitly asks for a component-system extraction.
