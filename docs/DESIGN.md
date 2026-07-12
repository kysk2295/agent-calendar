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

## 8. Accepted Debt

- The existing desktop app keeps much of the UI in `apps/desktop/src/App.tsx` and `apps/desktop/src/styles.css`. New work should stay scoped and avoid broad visual refactors unless the user explicitly asks for a component-system extraction.
