# Design Spec: Agent Orchestration Control UI

- Date: 2026-07-31
- Owner: Claude (design)
- Companion prototype: `apps/desktop/prototypes/agent-orchestration-control.html`
- Related: `docs/DESIGN.md`, `docs/plans/2026-07-31-agent-control-p0-wave1.md`, `docs/plans/2026-07-31-product-intent-spec-alignment.md`

## 1. Goals

- Provide an Orca-class multi-agent orchestration surface (Claude / Codex / Grok in parallel) framed as a **Delegated Work Control Space**, not a terminal wall.
- Keep the **Work Conversation** as the primary surface: one timeline, one composer, one Responsible Agent per work item.
- Represent parallel workers as **subordinate status rows** subordinate to that timeline, not as a bake-off leaderboard.
- Make natural-language delegation the primary create path (Mode A default); leave engine/agent overrides under advanced disclosure.
- Reinforce ADR 0007: execution engine is a secondary detail; the Responsible Agent owns accountability.
- Provide truthful, calm state feedback (accepted/queued/rejected/approval-required) using text plus subtle color, never color alone.

## 2. Non-Goals

- Mode B (named-role agent) full product surface and `@agent` syntax.
- Agent memory constellation graph.
- Terminal grid as the primary surface (secondary detail drawer only).
- Wiki auto-archive on completion.
- New palette or component system; must ride existing `docs/DESIGN.md` tokens.
- Backend orchestration protocol changes.

## 3. Information Hierarchy

**Primary (1급)** — always visible in the Work Conversation:

1. Work title + text status + Responsible Agent + next-action summary.
2. Chronological timeline: user messages, plan/approval/progress/blocked/completion/`수정 차수` checkpoints.
3. Always-available composer (text-first).
4. Subordinate parallel worker strip: 1 row per active worker with text state (수집 / 검증 / 초안 / 대기 / 차단됨), not a leaderboard.

**Secondary (2급)** — rail on wide, disclosure at ≤768, drawer on demand:

- Plan checklist, artifacts, current result pointer.
- Responsible Agent + requested engine + **actual resolved engine** (never invented; show `확인 필요` when unknown).
- Schedule, budget, policy.
- Task Session entry (execution transcript drawer).
- Per-worker execution detail (session-like log) reached from a worker row's "실행 상세 열기".

## 4. Layout Regions

Shell reuses the existing 220px sidebar and 40px top work bar. No shell rewrite.

**Desktop 1280**
```
┌ side 220 ┬───────────── main ───────────────┐
│          │ topbar 40 (Back · title · actions)│
│          ├──────────────────────────────────┤
│          │ header (h2 + status + next-action)│
│          │ worker strip (3 columns)          │
│          │ ┌ timeline ─────────┐ ┌ rail 300 ┐│
│          │ │ msgs + checkpoints │ │ plan     ││
│          │ │                    │ │ engine   ││
│          │ │                    │ │ artifacts││
│          │ │ composer (sticky)  │ │ session  ││
└──────────┴──────────────────────┴────────────┘
```

**Tablet 768** — rail collapses into an in-flow `<details>` disclosure below the timeline. Worker strip becomes 2 columns then 1. Header keeps Back + status + next-action.

**Mobile 375** — sidebar hidden (existing shell behavior for narrow reflow, not a mobile-only shell). Single column. Worker strip stacks. Composer stays sticky at bottom above safe area; never covers checkpoints. Actions wrap without truncating Korean copy. At 200% zoom, apply the same narrow reflow.

## 5. Component Inventory

- **Agent roster panel** (Control Home): shows every registered agent (Mode A/B) with avatar + name + mode tag + text status badge (실행 중 / 승인 대기 / 차단됨 / 대기) + one-line current activity + weekly count/success rate. Roster answers "누가 지금 뭘 하고 있나" at a glance; clicking a row jumps to that agent's active Work Conversation, or (if idle) opens their profile. Complements the work-centric attention list.
- **Status chip strip** (Control Home): `실행 중 N · 승인 대기 N · 차단됨 N · 오늘 완료 N · 수정 차수 대기 N` — text + tiny dot for scannability. Not color-only.
- **Delegate composer** (Control Home): single bordered frame with `무엇을 맡길까요?` label, `Enter` to submit, `Shift+Enter` for newline, `임시 저장` + `위임 보내기` actions, and an `advanced` `<details>` with agent / engine / comparison overrides. Do not double-border the textarea.
- **Work card**: three-column grid (bar · body · cta). Left bar color encodes state (accent/red/green/neutral) but text label repeats state. Includes `다음 액션` line.
- **Worker row** (subordinate strip in Work Conversation): name + role tag (수집 / 검증 / 초안) + text state + thin progress bar + elapsed/cost + "실행 상세 열기 →". Progress color augments but never replaces the label.
- **Timeline message**: `when · bubble`. User bubble slightly tinted, agent bubble neutral. Delivery label pinned under user messages (`접수됨` / `적용됨` / `다음 시도에 반영 예정` / `승인 필요` / `실행할 수 없음`).
- **Checkpoint**: colored left border + uppercase kind label + body + inline actions valid for that state. Variants: plan, approval, blocked, done, revision (수정 차수).
- **Composer** (Work Conversation): sticky, textarea + `보내기` (queue by default) + `지금 반영 (인터럽트)` secondary. Always available — including in loading, blocked, completed, approval-required, and 수정 차수 states.
- **Secondary rail panels**: 담당·엔진 · 계획 · 산출물 · Task Session (opens drawer).
- **Execution detail drawer**: header + monospace transcript (bg dark for legibility of runtime output) + meta strip (pid/host/tokens/cost/retries) + reverse-link back to which timeline events this run produced.

## 6. Parallel Orchestration Interaction

Reading model, top-to-bottom:

1. User reads the **header next-action** to know what needs them.
2. User glances the **worker strip** to see who is doing what right now, in role terms (수집/검증/초안), not engine bake-off terms.
3. If the user needs to intervene or judge, they read the **timeline**. Parallel work is summarized into user-meaningful checkpoints; raw fan-out lives in the drawer.
4. Any worker row's "실행 상세 열기" opens the per-worker execution drawer without leaving the work.

Rules:
- One timeline, one Responsible Agent, one current result — even with N parallel workers.
- Engine names appear as evidence (실제 엔진), not as accountable actors.
- Comparison mode surfaces additional workers in the strip and adds a `비교 모드` note in the engine rail; it never becomes a parallel report surface. The current result is still identified by `currentResultReportId`.
- Handoff between workers (e.g., 수집 → 검증 → 초안) is expressed through role tags and thin progress; verbose orchestration logs stay in the drawer.

## 7. Intervention UX

Two paths, always both available:

- **Queue (default)**: `보내기` records the message in the timeline, does not stop the current run, applies at the next checkpoint. Delivery label `다음 시도에 반영 예정 — 현재 실행은 중단하지 않습니다.`
- **Immediate (interrupt)**: `지금 반영 (인터럽트)` stops the current run, restarts with the new instruction. Delivery label `적용됨 · 다음 체크포인트 적용 요청됨`.

Additional labels, taken verbatim from `docs/DESIGN.md §5`:

- `접수됨` — stored, no direct application yet (may append `· <mode>` qualifier).
- `적용됨` — took effect (must not be used for merely stored messages).
- `승인 필요` — will not execute until user approves.
- `실행할 수 없음` — unsupported (external send/publish/purchase/delete) — no misleading approval button.

All labels are text with subtle color; the polite live region announces label changes without moving focus.

## 8. States (contract)

- **Loading** — keep header, Back, and composer; timeline marked busy; no fabricated checkpoint.
- **Empty (pre-plan)** — show the original request plus `아직 체크포인트가 없습니다`; composer enabled.
- **Approval required** — approval checkpoint names the consequence, scope, Responsible Agent; explicit 승인 / 거절 actions; work remains paused.
- **Blocked** — checkpoint names the blocker + safe next action (e.g., 자격증명 갱신); nothing removes the path back.
- **Recoverable error** — preserves selected work and draft, explains failure, offers retry (optionally: try another engine).
- **Completed** — completion checkpoint identifies the current result via `currentResultReportId`; invites 수정 차수. Earlier results remain visible chronologically.
- **수정 차수 N** — insert `수정 차수 N 시작/완료` markers; prior results preserved; exactly one result labeled current.
- **No state** ever collapses to a blank panel or removes Back / composer.

## 9. Accessibility

- Every worker/timeline/state uses a visible text label — status is never color-only.
- Approval and blocker checkpoints use descriptive headings and explicit action labels; completion and 수정 차수 do not rely on color, animation, or relative position alone.
- Composer supports `Enter` submit, `Shift+Enter` newline; send/interrupt/session-open have accessible names and stable 30px targets (44px at ≤768px).
- Work cards are keyboard-reachable; opening a work moves focus to the Work Conversation heading without skipping Back. Back restores focus to the originating card or, if gone, to Control Home recent-work heading.
- Delivery label changes announce through a polite live region without moving focus.
- Execution detail drawer transcript is `role="log"` with `aria-live="off"` (opt-in; the surface is diagnostic, not attention-grabbing).
- Respect `prefers-reduced-motion: reduce`; no primary transition depends on motion for meaning.

## 10. Mapping to Existing React Files

For implementers on `kysk2295/agent-control-p0-wave1`:

| Spec element | React source |
|---|---|
| Control Home shell, cards, delegate composer | `apps/desktop/src/features/agent-operations/AgentWorkWorkspace.tsx` (Control Home mode); delegate lives alongside `AgentWorkComposer.tsx` |
| Work Conversation header + status + next-action | `AgentWorkConversationView.tsx` header block |
| Timeline messages + checkpoints + delivery labels | `AgentWorkConversationView.tsx` message renderer; delivery-label mapping in agent-operations reducer/selectors |
| Subordinate worker strip | New presentational component (e.g. `AgentWorkerStrip.tsx`) mounted between header and timeline in `AgentWorkConversationView.tsx`; data from existing comparison/engine plan output |
| Composer (queue + interrupt) | `AgentWorkComposer.tsx` — extend action row; interrupt is secondary (not primary button) |
| Secondary details rail | `AgentWorkConversationView.tsx` rail region; collapses to `<details>` at narrow breakpoints |
| Execution detail drawer | Route-off from Task Session entry / worker "실행 상세 열기"; likely reuses existing session transcript component |
| Tokens & spacing | `apps/desktop/src/features/agent-operations/agent-workspace.css` — reuse `--accent`, `--panel`, `--line*`, `--muted*`; do not introduce new palette |

Prototype `apps/desktop/prototypes/agent-orchestration-control.html` is a density and interaction reference only — its markup is not an interaction contract for the React app.

## 11. Open Questions

1. Do we mount the worker strip **only** when comparison/parallel plan is active, or always as a single row (Responsible Agent presence)? Recommendation: always show at least one row for consistency; expand when parallel.
2. Interrupt semantics: is a running Codex/Grok worker actually cancelable end-to-end today, or do we only mark the queue and let the current step finish? Copy must match runtime truth (`적용됨` vs `다음 시도에 반영 예정`).
3. Should the delegate composer's `임시 저장` be scoped per work draft or per Control Home draft? Prototype shows Control Home only.
4. Where do routine/automation cards live long-term — Control Home read-only summaries (current) vs promoted to Hermes tab only?
5. What is the minimum evidence to claim `실제 엔진`? Explicit runtime attribution required; otherwise show `확인 필요`.
6. Cost/token surface: rail vs drawer only? Prototype shows both (rail: budget; drawer: per-run tokens/cost).

## 12. How to Open the Prototype

```
open apps/desktop/prototypes/agent-orchestration-control.html
```

Use the top toolbar to switch between the 5 screens (Control Home / Work Conversation / Execution Detail / Intervention / States) and to preview 1280 / 768 / 375 widths.
