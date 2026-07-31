# Product Intent & Spec Alignment Report

- Date: 2026-07-31
- Mode: read-only full analysis
- Task: extract official product intent and score shipped codebase alignment
- Workspace: `/Users/koyunseo/orca/workspaces/agent-calendar/escolar`

## 1) Product one-liner and primary user job

**One-liner (canonical, from CONTEXT):**  
Agent Calendar is a **calendar-first operations context** for scheduling, delegating, observing, reviewing, and steering accountable agent work.  
Evidence: `CONTEXT.md` L1–L3.

**Primary user job:**  
As a single Workspace operator, entrust an outcome to a **Responsible Agent** as **Delegated Work**, then use one **Work Conversation** to plan, observe checkpoints, intervene, approve when required, and revise—without treating the product as free-form agent chat or as an engine picker.  
Evidence: `CONTEXT.md` L23–L77; `docs/adr/0001-one-work-conversation-per-delegated-work.md`; `docs/adr/0006-selected-work-opens-as-the-primary-workspace.md`; `docs/adr/0007-visible-agent-hidden-engine.md`.

**Shell product destinations (intended):**  
Calendar · Agent Work · Automation as always-visible destinations; schedule utilities / Knowledge / Runner / widgets inside `작업공간`.  
Evidence: `docs/DESIGN.md` L66–L68; `apps/desktop/src/App.tsx` L343–L360 (`primaryNavItems` / `secondaryNavItems`).

---

## 2) Canonical vocabulary table

Source of truth: `CONTEXT.md`. Avoid-terms are product language constraints, not just synonyms.

| Term (EN / KO) | Meaning (condensed) | Avoid | Source |
|---|---|---|---|
| **Workspace / 작업공간** | Ownership isolation: calendars, knowledge, Delegated Work, automations, policies, Runner connections; one operator per Workspace in first production | User DB, global state, account | `CONTEXT.md` L7–L9 |
| **Unified Calendar / 통합 캘린더** | Timeline of human schedule + independently running agent/automation occurrences (overlap OK) | Human-resource optimizer, conflict-free scheduler | `CONTEXT.md` L11–L13 |
| **Calendar AI / 캘린더 AI** | Workspace-owned conversational counterpart over authorized schedules/knowledge; can create calendar changes, Delegated Work, automation changes | Schedule search, omniscient chatbot, direct DB agent | `CONTEXT.md` L15–L17 |
| **Personal Memory / 개인 기억** | User-visible retained facts/preferences for Calendar AI with provenance/deletion | Hidden profile, raw archive, calendar cache | `CONTEXT.md` L19–L21 |
| **Agent Work Control Space / 에이전트 작업 관제 공간** | Surface to delegate, observe, review, intervene | Agent chat, chatbot | `CONTEXT.md` L23–L25 |
| **Control Home / 관제 홈** | Default when no Delegated Work selected; attention summary + new work entry | Dashboard as permanent work surface | `CONTEXT.md` L27–L29 |
| **Work Conversation View / 작업 대화 화면** | Primary workspace for one selected Delegated Work | Drawer, report viewer | `CONTEXT.md` L31–L33 |
| **Delegated Work / 위임 작업** | One outcome-oriented request; owns one Work Conversation; may have subordinate tasks | Chat, individual task | `CONTEXT.md` L35–L37 |
| **Responsible Agent / 담당 에이전트** | Visible agent accountable for one Delegated Work | Model, execution engine | `CONTEXT.md` L39–L41 |
| **Execution Engine / 실행 엔진** | Runtime mechanism; secondary to Responsible Agent; actual resolved engine only with evidence | Responsible agent, required choice before delegation | `CONTEXT.md` L43–L45 |
| **Runner / 러너** | Customer-controlled host bound to exactly one Workspace | Execution engine, model, central server, global worker pool | `CONTEXT.md` L47–L49 |
| **Runner Enrollment / 러너 등록** | Owner-confirmed binding of host identity to one Workspace | Login, reusable pairing link, shared Runner secret | `CONTEXT.md` L51–L53 |
| **Connected Automation / 연결 자동화** | Automation still run by source system; projected/managed via calendar + control UI | Copied automation, migrated job | `CONTEXT.md` L55–L57 |
| **Automation Change Policy / 자동화 변경 정책** | Which automation edits apply directly vs Approval Gate | Blanket autonomy, approve-every-edit | `CONTEXT.md` L59–L61 |
| **Work Conversation / 작업 대화** | Operational conversation for one Delegated Work across full lifecycle | Free chat, general chat, report comments | `CONTEXT.md` L63–L65 |
| **Intervention / 개입** | Instruction that changes direction/state/output | Comment, passive feedback | `CONTEXT.md` L67–L69 |
| **Approval Gate / 승인 관문** | Explicit decision for already-supported consequential actions only | Confirm every message, blanket approval | `CONTEXT.md` L71–L73 |
| **Work Checkpoint / 작업 체크포인트** | User-meaningful work change in conversation | Raw log, heartbeat, status noise | `CONTEXT.md` L75–L77 |
| **수정 차수** | Same-outcome revision attempt; prior results retained; one current result | New work, overwritten result | `CONTEXT.md` L79–L81 |
| **Follow-up Work / 후속 작업** | Materially different goal as separately created Delegated Work; auto-create deferred | Revision, continuation of same result | `CONTEXT.md` L83–L85 |

Related internal terms still present in code (not CONTEXT vocabulary): **mission**, **Task Session**, **chat** (Calendar AI drawer).  
Evidence: `apps/desktop/src/features/agent-operations/types.ts` (`AgentMission*`); `docs/DESIGN.md` L111–L112 (Task Session optional secondary); `apps/desktop/src/features/communication/ChatDrawer.tsx`.

---

## 3) Intended non-goals / deferred items

### From CONTEXT.md
- Cross-workspace / multi-operator global product model (first release = one operator per Workspace).
- Treating Unified Calendar as conflict-free human resource optimizer.
- Omniscient chatbot / direct-database agent for Calendar AI.
- Hidden profile memory; calendar cache as memory.
- Free chat / agent chatbot framing for Agent Work Control Space.
- Dashboard as permanent primary work surface.
- Drawer / report-viewer as primary work surface.
- Requiring Execution Engine choice before delegation.
- Automatic Follow-up Work creation/linking (returns `follow_up_required`; user must create new work).
- Reassigning Responsible Agent on **existing** work (deferred).
- Turning unsupported external send/publish/purchase/delete into Approval Gate or Follow-up Work.

Evidence: `CONTEXT.md` L7–L85.

### From ADRs 0001–0007
| ADR | Decision | Explicit non-goal / deferred |
|---|---|---|
| 0001 | One Work Conversation per Delegated Work | Do not fragment user history into per-task chats |
| 0002 | NL interventions + bounded Approval Gates | Not every message is a confirmation form; no unbounded authority; unsupported external fails closed without fake approval |
| 0003 | Conversation spans full lifecycle | Not gated on subordinate execution session creation; no disabled composer as session lifecycle |
| 0004 | One timeline of messages + checkpoints | No separate primary report/log surfaces; raw tool noise not primary |
| 0005 | Revisions stay; new goals branch | No auto Follow-up creation/link; unsupported external ≠ Follow-up |
| 0006 | Selected work = primary workspace | No persistent side list + drawer over board as primary interaction |
| 0007 | Visible agent, hidden/secondary engine | No engine-first primary path; existing-work reassignment deferred |

Evidence: `docs/adr/0001-*.md` … `docs/adr/0007-*.md`.

### From personal beta ops intent
- **Not** a public multi-user service; single-owner desktop + Railway gateway personal beta.
- Public distribution (Developer ID + notarization) is an upgrade path, not current beta claim.
- Telegram: existing-poller coexistence for current owner; not webhook multi-tenant product path by default.
- Do not silently fall back across Responsible Agents / Execution Engines on runtime failure.

Evidence: `docs/operations/personal-beta-release.md` L1–L4, L109–L170, L189–L233.

### From recent plans (intent direction, not all shipped)
| Plan | Non-goals / deferred of note |
|---|---|
| `docs/plans/2026-07-26-unified-cross-channel-work-conversation.md` | No mobile before Desktop/Web gate; no Slack/Teams/Discord in first slice; no auto multi-model fan-out for every message; Telegram env routing not multi-user product path |
| `docs/plans/2026-07-26-telegram-ingress-ownership.md` | No auto stop of existing Hermes poller; no token/chat-id to Gateway; no webhook conversion in that slice |
| `docs/plans/2026-07-26-telegram-ingress-readiness.md` | No additional live Telegram probing as part of readiness projection |
| `docs/plans/2026-07-26-persistent-agent-profile-memory-live-work.md` | No auto long-term memory promotion; no merge of agent memory with Calendar AI / Wiki / provider session; no tool grant marketplace |
| `docs/plans/2026-07-31-calendar-wiki-ai-pipeline-analysis.md` | Documents residual Calendar AI dual-path drift (chat stream vs `/api/assistant/ask`) — honesty/contract risk |

### From DESIGN accepted debt
- Large UI still concentrated in `App.tsx` / `styles.css`; no broad component-system extraction unless asked.  
Evidence: `docs/DESIGN.md` L137–L139.

---

## 4) Alignment matrix

| Intent claim | Evidence path | Verdict |
|---|---|---|
| Product is calendar-first ops for accountable agent work | `CONTEXT.md` L1–L3; nav defaults calendar + Unified Calendar screen meta `App.tsx` L264 | **aligned** |
| Primary destinations: Calendar, Agent Work, Automation | `docs/DESIGN.md` L66–L68; `App.tsx` L343–L347 (`primaryNavItems`) | **partial** — UI labels `에이전트` / `자동화` not “Agent Work Control Space”; secondary nav still exposes many GTD surfaces |
| Control Home only when no work selected; selecting work replaces it | `docs/adr/0006-*.md`; `AgentWorkWorkspace.tsx` L287–L343 (conversation) vs L345–L394 (control shell + board) | **aligned** (primary path) |
| Work Conversation is primary surface (not drawer) | `AgentWorkConversationView.tsx` L175–L241; `docs/DESIGN.md` L103 | **aligned** for main path; **partial** residual `AgentWorkDrawer.tsx` still in tree (not wired into App primary flow per import grep) |
| One conversation per Delegated Work across lifecycle | `docs/adr/0001`, `0003`; `workConversationTypes.ts` `AgentWorkConversationPage`; composer always available `AgentWorkComposer.tsx` | **aligned** |
| One timeline of messages + Work Checkpoints | `docs/adr/0004`; checkpoint kinds in `workConversationTypes.ts` L3–L16; `AgentWorkTimeline` usage in conversation view | **aligned** (contract); presentation quality called out as ongoing in cross-channel plan |
| Interventions are operational; unsupported external fail-closed | `docs/adr/0002`; delivery modes include `unsupported_external_request` / `follow_up_required` in `workConversationTypes.ts` L25–L32; presentation copy in `workConversationPresentation.ts` | **aligned** (contract) |
| Responsible Agent visible; engine secondary | `docs/adr/0007`; header shows 담당 + 배정 reason `AgentWorkConversationView.tsx` L183–L185; advanced engine on create `AgentWorkWorkspace.tsx` L389 | **partial** — header also surfaces **실행** engine co-equal; composer has always-on engine select + **엔진 비교** `AgentWorkComposer.tsx` L159–L208 |
| NL delegation without required mission title / engine / agent | `docs/DESIGN.md` L106; Control Home bar `AgentWorkWorkspace.tsx` L385–L388 (NL + 위임; engine under advanced) | **aligned** on Control Home path |
| Agent Work is not “agent chat” | CONTEXT avoid-list; primary UI uses 작업 대화 / 관제 홈 | **partial** — Calendar AI still `ChatDrawer` + `chatMessages` / `sendChat` (`App.tsx` L91, L2354 area, L3462); legacy mission/chat copy remains |
| Dashboard is not permanent work surface | Control Home is temporary; conversation replaces it | **partial** — `AgentCommandCenter.tsx` still encodes metrics “command center / Hermes 운영 현황” dashboard grammar (legacy component still in feature tree) |
| Task Session secondary only | `docs/DESIGN.md` L111–L112; `TaskSessionPanel` imported in `App.tsx` L70, L3449 | **aligned** as optional surface; **partial** if users reach session as parallel result path |
| Connected Automation separate tab with truthful status | `docs/DESIGN.md` L101–L102; `HermesAutomationDashboard` + `App.tsx` automation screen | **aligned** directionally (Hermes-named implementation) |
| Personal beta = single-owner, not public multi-user | `docs/operations/personal-beta-release.md` L1–L4 | **aligned** with release intent docs (ops, not product multi-tenancy claim) |
| Cross-channel one Work Conversation (Desktop + Telegram) | Recent plans 2026-07-26 unified + telegram; conversation view Telegram panel `AgentWorkConversationView.tsx` L192–L227 | **partial** — implementation progressing; ownership/readiness honesty added; production completion pass still “in progress” on parent plan |
| Calendar AI honesty contracts | Analysis plan `docs/plans/2026-07-31-calendar-wiki-ai-pipeline-analysis.md` | **partial / drift** — FAB chat stream path vs contract `/api/assistant/ask` |
| Vocabulary: mission retired in favor of Delegated Work | CONTEXT / DESIGN user language | **drift** — types/API/UI still heavily `mission` (`types.ts` `AgentMission*`; `AgentMissionComposer.tsx` “새 미션”; `App.tsx` L4211 “새 미션 위임”; `MissionDetail` “미션 일시정지”) |
| Engine choice omitted from primary flow | ADR 0007 | **partial** on create (advanced only); **drift** on message compose (engine select always visible; comparison mode elevates engines) |

---

## 5) Top 8 product-intent risks

Where UI/language still says **chat / dashboard / engine-first / mission** rather than control-space intent:

1. **Engine-first composer toolbar**  
   Always-visible “이 메시지의 실행 엔진” + “엔진 비교” elevates Execution Engine to primary interaction despite ADR 0007.  
   Path: `apps/desktop/src/features/agent-operations/AgentWorkComposer.tsx` L159–L218.

2. **Mission vocabulary still product-facing**  
   “미션”, “새 미션 위임”, “미션 일시정지/재개/중단” conflict with Delegated Work / Work Conversation vocabulary.  
   Paths: `AgentMissionComposer.tsx`; `AgentOperationViews.tsx` (`MissionDetail`); `App.tsx` L4211–L4245; `types.ts` mission types.

3. **Calendar AI still framed as Chat**  
   Component `ChatDrawer`, state `chatMessages`, `sendChat`, dual stream path vs schedule-assistant contract undermines “Calendar AI not omniscient chatbot” and honesty contracts.  
   Paths: `apps/desktop/src/features/communication/ChatDrawer.tsx`; `App.tsx` chat FAB L3292–L3294, L3462; analysis `docs/plans/2026-07-31-calendar-wiki-ai-pipeline-analysis.md`.

4. **Legacy command-center / dashboard surfaces remain in tree**  
   `AgentCommandCenter.tsx` metrics dashboard + “Hermes · Local · Codex” engine marketing; even if not primary nav, it encodes the avoid-list grammar and confuses future wiring.  
   Path: `AgentCommandCenter.tsx` L38–L72.

5. **Work drawer / mission detail dual models**  
   `AgentWorkDrawer.tsx` and `MissionDetail` encode report/session-centric “drawer/report viewer” patterns ADR 0006 and CONTEXT avoid. Residual parallel mental model for contributors and tests.  
   Paths: `AgentWorkDrawer.tsx`; `AgentOperationViews.tsx` L145+; test reference in `apps/desktop/tests/playwright-agent-work-verifier.cjs`.

6. **Nav label “에이전트” under-specifies Control Space**  
   DESIGN/CONTEXT name Agent Work Control Space / 관제; shipping label is generic “에이전트” + subtitle “작업 위임 · 실시간 실행” which can read as live-engine ops more than accountable work conversation.  
   Path: `App.tsx` L276, L345.

7. **Hermes/runtime branding leaks into Control Home**  
   “Hermes 스케줄러 온라인”, automation framed as Hermes-first, risks Runner/engine identity over Workspace operator accountability.  
   Paths: `AgentWorkWorkspace.tsx` L375–L383; `HermesAutomationDashboard.tsx`; personal beta still Hermes-runtime coupled.

8. **Primary status line co-displays engine with Responsible Agent**  
   Header `담당` + `실행` side-by-side makes engine look peer accountability rather than secondary detail (DESIGN: secondary rail / details).  
   Path: `AgentWorkConversationView.tsx` L181–L186; contrast `AgentWorkDetails.tsx` which correctly separates 요청 방식 vs 실제 실행.

---

## 6) Priority recommendations (serve the intent)

| ID | Recommendation | Priority | Impact | Effort | Why it serves intent |
|---|---|---|---|---|---|
| R1 | Demote engine UI: hide engine/model behind “고급” on **message** compose by default; keep comparison as explicit advanced opt-in only | **P0** | High | Medium | Restores ADR 0007 “visible agent, secondary engine” without killing power users |
| R2 | User-facing vocabulary pass: replace 미션→위임 작업 / 작업 in Korean UI copy; keep `missionId` internal if needed | **P0** | High | Medium | Closes largest language drift vs CONTEXT; reduces chat/mission mental model |
| R3 | Align Calendar AI entry to contract path (`/api/assistant/ask` or equivalent honesty meta); rename ChatDrawer→Calendar AI surface in UI/code names over time | **P0** | High | Medium–Large | Fixes chatbot framing + honesty drift called out in 2026-07-31 analysis |
| R4 | Retire or quarantine dead legacy surfaces (`AgentCommandCenter`, `AgentMissionComposer` if unused, drawer-primary flows) with tests pointing only at Control Home + Work Conversation | **P1** | Medium | Small–Medium | Prevents reintroduction of dashboard/drawer grammar |
| R5 | Rename primary nav/subtitle toward 관제 / Agent Work language (“에이전트 작업” or “관제”) without emoji ops tone | **P1** | Medium | Small | Matches DESIGN + CONTEXT product destinations |
| R6 | Move header engine chip into secondary details rail; keep 담당 + 배정 reason primary | **P1** | Medium | Small | Matches DESIGN secondary-details contract |
| R7 | Finish cross-channel Work Conversation honesty (Telegram readiness + no dual transcripts) per 2026-07-26 plans; close production completion pass | **P1** | High | Large | Supports “one conversation” across endpoints without engine/session fragmentation |
| R8 | Keep multi-user / public distribution / auto follow-up / agent reassignment **explicitly deferred** in product copy and release notes | **P2** | Medium | Small | Protects personal-beta intent and ADR 0005/0007 deferrals from accidental scope claims |

### Suggested sequencing
1. P0 language + engine demotion (R1, R2) — visible intent fix with limited API risk.  
2. P0 Calendar AI contract alignment (R3) — separate honesty boundary.  
3. P1 dead-surface retirement + nav/header polish (R4–R6).  
4. P1 channel completion (R7).  
5. P2 scope discipline in docs/release (R8).

---

## Appendix A — Sources read

| Path | Role |
|---|---|
| `CONTEXT.md` | Canonical product vocabulary + one-liner |
| `AGENTS.md` | Agent workflow (plan-first); not product intent source |
| `docs/DESIGN.md` | Shell, Control Home, Work Conversation visual/interaction contracts |
| `docs/adr/0001`–`0007` | Product architecture decisions |
| `docs/adr/0008`–`0009` | Present in tree; out of assigned 0001–0007 scope (Runner bind / provider auth) |
| `docs/agent-development-methodology.md` | Dev process, not product intent |
| `docs/plans/README.md` | Plan filing convention |
| Recent 5 plans by date | `2026-07-31-calendar-wiki-ai-pipeline-analysis.md`, `2026-07-26-unified-cross-channel-work-conversation.md`, `2026-07-26-telegram-ingress-readiness.md`, `2026-07-26-telegram-ingress-ownership.md`, `2026-07-26-persistent-agent-profile-memory-live-work.md` |
| `docs/operations/personal-beta-release.md` | Personal beta (single-owner) intent only |
| `apps/desktop/src/features/agent-operations/*` | Shipped Agent Work UI/types |
| `apps/desktop/src/App.tsx` | Screen list / nav groups only (plus cited chat/mission string evidence) |

## Appendix B — agent-operations surface inventory (file list)

35 files under `apps/desktop/src/features/agent-operations/`, including:

- **Primary path:** `AgentOperationsScreen.tsx` → `AgentWorkWorkspace.tsx` → (`AgentControlRoomBoard.tsx` | `AgentWorkConversationView.tsx` + `AgentWorkTimeline.tsx` + `AgentWorkComposer.tsx`)
- **Supporting:** `workConversationTypes.ts`, `workConversationPresentation.ts`, `workConversationValues.ts`, `useAgentWorkConversation.ts`, `useAgentWorkLiveTurn.ts`, `AgentWorkDetails.tsx`, `AgentDirectoryPanel.tsx`, `HermesAutomationDashboard.tsx`, `executionContracts.ts`, `types.ts`
- **Legacy / secondary risk:** `AgentCommandCenter.tsx`, `AgentMissionComposer.tsx`, `AgentWorkDrawer.tsx`, `AgentOperationViews.tsx` (`MissionDetail`), `TaskSessionPanel.tsx`

## Appendix C — App screen / nav summary

**ScreenId** (`App.tsx` L169):  
`onboarding | calendar | today | next7 | tasks | kanban | mail | notes | someday | review | wiki | diary | search | agents | automation | widgets | settings | login | runner`

**Primary nav:** 캘린더 · 에이전트 · 자동화  
**Secondary under 작업공간:** 오늘 · 다음 7일 · 기본함 · 메일함 · 칸반 보드 · 위키 · 주간 회고 · 일기 · Runner 설정 · 위젯 + taxonomy list/tag groups  
Evidence: `App.tsx` L343–L360, L3236–L3268.

---

## Executive summary (for coordinator)

I read CONTEXT, DESIGN, ADRs 0001–0007, methodology, personal-beta ops, the five newest plans, App nav, and the agent-operations feature surface, and wrote a full alignment report at `docs/plans/2026-07-31-product-intent-spec-alignment.md`. Official intent is a calendar-first control space for accountable Delegated Work via one Work Conversation (agent visible, engine secondary), and the shipped primary path largely implements Control Home → full-width Work Conversation, while residual **mission/chat/dashboard/engine-first** language and Calendar AI dual-path honesty remain the main drift. No product code was changed; remaining work is P0 engine demotion + vocabulary/Calendar-AI contract fixes, then P1 legacy surface retirement and cross-channel completion.
