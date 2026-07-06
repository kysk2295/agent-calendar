# Button Audit 2026-07-04

## Calendar Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Toolbar | `월` / `주` / `일` segmented controls | Switches calendar layout without losing current date context | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| Toolbar | `오늘` | Resets calendar date to today and clears placement mode | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| Toolbar | `‹` / `›` | Moves month/week/day range according to active view | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| Month view | Date number inside today cell | Opens day view for that date | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| Month view | Event/task pill | Opens detail modal for selected calendar item | `tests/playwright-calendar-surface-buttons.cjs`, `tests/playwright-calendar-detail-complete.cjs` | Verified |
| Week view | Empty day event area | Opens new task popover for that date | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| Week view | Day header | Opens day view for that date | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| Day view | Empty hour row | Opens new task popover with date/time context | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| Day view | All-day task checkbox | Completes task through `/api/tasks/:id` | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| Day view | `시간 잡기` then hour row | Moves task into selected hour through `/api/tasks/:id` | `tests/playwright-calendar-surface-buttons.cjs` | Verified |
| New task popover | `닫기` | Closes popover without creating a task | `tests/playwright-calendar-surface-buttons.cjs` | Fixed: `src/App.tsx` |
| Detail modal | Top-left checkbox for calendar event records | Completes event through `/api/calendar/events/:id`, not task API, with immediate detail UI feedback and failure rollback | `tests/playwright-calendar-detail-complete.cjs`, `tests/playwright-calendar-detail-complete-failure.cjs`, `tests/railway-data-contract.test.mjs` | Fixed: `src/App.tsx` |
| Detail modal | Date/list/duration/delete flows | Patch/delete through correct task or calendar API | `tests/playwright-calendar-crud.cjs`, `tests/playwright-task-detail-date-list.cjs` | Verified |
| Detail modal | Flag / format / comment / more / reminder controls for calendar event records | Patch event metadata through `/api/calendar/events/:id` and never task API | `tests/playwright-calendar-detail-tools.cjs` | Verified |

### Findings

- Fixed missing new-task popover close button. The stylesheet already had `.new-close`, but the button was not rendered.
- Fixed calendar detail checkbox completion for calendar-event records in the prior pass.
- Added explicit calendar-event coverage for detail format/comment/more/reminder controls and completion failure rollback.

## Task List Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Quick add | `추가` button | Creates a task through `/api/tasks`, waits for hydrate visibility, then clears input | `tests/playwright-task-list-surface-buttons.cjs`, `tests/playwright-quick-add-stale-hydrate.cjs` | Verified |
| Quick add | Repeat template chips | Fills quick-add input with the selected repeat template text | `tests/playwright-task-list-surface-buttons.cjs` | Verified |
| Sections | Overdue collapse / expand button | Hides and restores overdue rows | `tests/playwright-task-list-surface-buttons.cjs` | Verified |
| Sections | `연기하다` | Moves overdue tasks to today through `/api/tasks/:id` | `tests/playwright-task-actions.cjs` | Verified |
| Rows | Row checkbox | Completes task through `/api/tasks/:id` and supports undo toast | `tests/playwright-task-actions.cjs` | Verified |
| Rows | Row click | Selects task and updates inspector panel | `tests/playwright-task-list-surface-buttons.cjs` | Verified |
| Rows | Row double-click | Opens full detail modal | `tests/playwright-task-actions.cjs` | Verified |
| Completed block | Summary disclosure | Shows completed rows and allows selecting them into inspector | `tests/playwright-task-list-surface-buttons.cjs` | Verified |
| Inspector | Close button | Closes inspector into empty state | `tests/playwright-task-list-surface-buttons.cjs`, `tests/playwright-task-inspector-tools.cjs` | Verified |
| Inspector | Flag / subtask / format / comment / more | Patches priority, notes, date, and repeat through `/api/tasks/:id` | `tests/playwright-task-inspector-tools.cjs` | Verified |

## Today Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Quick add | `추가` button | Creates a today task through `/api/tasks` and clears input after hydrate visibility | `tests/playwright-today-surface-buttons.cjs` | Verified |
| Today tasks | Row click | Opens full task detail modal | `tests/playwright-today-surface-buttons.cjs` | Verified |
| Today tasks | Checkbox | Completes task through `/api/tasks/:id` and shows completion toast before slow hydrate finishes | `tests/playwright-task-complete-toast-before-hydrate.cjs` | Verified |
| Overdue tasks | `오늘로` / `내일로` | Reschedules overdue task through `/api/tasks/:id` | `tests/playwright-today-surface-buttons.cjs` | Fixed: `src/App.tsx` |
| Agent review | Review row click | Opens run detail modal | `tests/playwright-today-surface-buttons.cjs` | Verified |
| Agent review | `승인` | Approves run through `/api/runs/:id/approve` and removes row | `tests/playwright-today-surface-buttons.cjs`, `tests/playwright-run-approval.cjs` | Verified |
| Suggestions | `+ 오늘` | Moves undated task to today through `/api/tasks/:id` | `tests/playwright-today-surface-buttons.cjs` | Fixed: `src/App.tsx` |

### Findings

- Fixed Today screen data flow. The parent was passing only today-dated tasks, which made overdue tasks and undated suggestions unreachable even though TodayScreen had UI for them.

## Next 7 Days Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Navigation | `다음 7일` nav item | Shows only dated tasks from today through day 7 | `tests/playwright-next7-kanban-surface-buttons.cjs` | Verified |
| Quick add | `추가` button | Creates task through `/api/tasks` with today fallback date | `tests/playwright-next7-kanban-surface-buttons.cjs` | Verified |
| Rows / inspector | Task list interactions | Reuses Task List Screen row and inspector behavior | `tests/playwright-task-list-surface-buttons.cjs`, `tests/playwright-task-inspector-tools.cjs` | Verified |

## Kanban Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Columns | Status grouping | Groups planned, doing, review, and done tasks into 4 columns | `tests/playwright-next7-kanban-surface-buttons.cjs` | Verified |
| Cards | Kanban card click | Opens full task detail modal | `tests/playwright-next7-kanban-surface-buttons.cjs` | Verified |

## Mail Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Inbox list | Mail item click | Selects mail and updates reader panel | `tests/playwright-mail-surface-buttons.cjs` | Verified |
| Header | `⟳` refresh with empty Gmail fields | Shows validation message and does not call mail APIs | `tests/playwright-mail-surface-buttons.cjs` | Verified |
| Gmail form | `연결 · 동기화` / header refresh with credentials | Saves account, syncs mail, clears password on valid sync response | `tests/playwright-mail-surface-buttons.cjs` | Verified |
| Gmail form | Invalid account | Shows failure without calling sync | `tests/playwright-mail-gmail-connect.cjs` | Verified |
| Gmail form | Empty sync response | Preserves password and shows failure | `tests/playwright-mail-gmail-sync-empty-response.cjs` | Fixed: `src/App.tsx` |
| Reader | Star button | Toggles star through inbox command and rolls back on failure | `tests/playwright-mail-actions.cjs`, `tests/playwright-mail-star-failure-rollback.cjs` | Verified |
| Reader | `작업으로 추가` | Runs inbox task command and rolls back action status on failure | `tests/playwright-mail-actions.cjs`, `tests/playwright-mail-task-failure-rollback.cjs` | Verified |
| Reader | `에이전트에 위임` / `답장 초안` | Opens delegate modal with appropriate prompt text | `tests/playwright-mail-actions.cjs` | Verified |
| Reader | `보관` | Runs archive command, removes selected mail on success, restores selection on failure | `tests/playwright-mail-actions.cjs`, `tests/playwright-mail-archive-failure-selection.cjs` | Verified |

## Weekly Review Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Goals | Goal button | Toggles goal completion through `/api/tasks/:id` | `tests/playwright-review-surface-buttons.cjs` | Verified |
| Goals | Goal input Enter | Creates review goal through `/api/tasks` and clears input on success | `tests/playwright-review-surface-buttons.cjs`, `tests/playwright-review-goal-failure.cjs` | Verified |
| Retro | `자동 생성` | Generates draft through backend wiki/LLM API and preserves existing draft on regeneration failure | `tests/playwright-review-surface-buttons.cjs`, `tests/playwright-review-regenerate-failure-preserves-draft.cjs` | Verified |
| Retro | `위키에 저장` | Saves generated retro through `/api/documents` and preserves draft on save failure | `tests/playwright-review-surface-buttons.cjs`, `tests/playwright-review-save-failure-preserves-draft.cjs` | Verified |

## Wiki / Search Screens

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Sidebar | Search trigger | Opens Search screen from the sidebar search button | `tests/playwright-search-doc-open.cjs`, `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Search | Query input | Filters task and wiki result groups by query text | `tests/playwright-search-query-filter.cjs` | Verified |
| Search | Task result row | Opens task detail modal with the selected task | `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Search | Wiki result row | Opens Wiki screen reader with the selected document body | `tests/playwright-search-doc-open.cjs`, `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Wiki askbar | Suggestion chips | Fill the ask input without submitting | `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Wiki askbar | `질문` button / Enter | Searches wiki context and streams curator answer | `tests/playwright-wiki-graph-ask.cjs`, `tests/playwright-wiki-scope-options.cjs` | Verified |
| Wiki scope | `일기 포함` / `raw 포함` | Sends include flags to wiki search request | `tests/playwright-wiki-scope-options.cjs` | Verified |
| Wiki answer | `✕` | Dismisses answer and clears ask input | `tests/playwright-wiki-answer-dismiss.cjs` | Verified |
| Graph | Zoom in / zoom out / reset | Updates graph transform and resets to `translate(0 0) scale(1)` | `tests/playwright-wiki-graph-ask.cjs`, `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Graph | Drag canvas | Pans graph viewport without opening a document | `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Graph | Node click | Opens reader for the clicked wiki node | `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Tree | Group toggle | Expands and collapses matching folder rows | `tests/playwright-wiki-tree-search.cjs` | Verified |
| Tree | Tree search input | Filters tree docs without showing non-matching docs | `tests/playwright-wiki-tree-search.cjs`, `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Tree | Document row | Opens reader for the selected tree document | `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |
| Reader | `✕` | Closes reader without changing current screen | `tests/playwright-wiki-search-surface-buttons.cjs` | Verified |

## Diary Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Mood picker | Mood button | Toggles selected mood on/off and includes mood in saved diary body | `tests/playwright-diary-surface-buttons.cjs` | Verified |
| Prompt chips | `+ ...` prompt buttons | Append selected prompt to diary textarea | `tests/playwright-diary-surface-buttons.cjs` | Verified |
| Save | `위키에 저장` success | Creates diary document, clears text and mood only after persisted document identity is returned | `tests/playwright-diary-surface-buttons.cjs` | Verified |
| Save | Backend failure | Preserves diary text and selected mood and shows API error | `tests/playwright-diary-save-failure-preserves-input.cjs` | Verified |
| Save | Empty success response | Preserves diary text and selected mood and shows empty-response error | `tests/playwright-diary-save-empty-response.cjs` | Fixed: `src/App.tsx` |
| Timeline | Past diary row | Loads/restores the selected past diary body into the editor | `tests/playwright-diary-journal.cjs`, `tests/playwright-diary-surface-buttons.cjs` | Verified |

## Agents Screen

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Mission | Example buttons | Fill mission textarea with selected example prompt | `tests/playwright-agent-surface-buttons.cjs` | Verified |
| Mission | Agent chips | Select assigned agent and send its id in launch payload | `tests/playwright-agent-surface-buttons.cjs`, `tests/playwright-agent-mission.cjs` | Verified |
| Mission | `계획 세우기` | Creates agent-owned task, launches mission, and opens run modal | `tests/playwright-agent-mission.cjs`, `tests/playwright-agent-surface-buttons.cjs` | Verified |
| Mission | Empty launch response | Keeps mission text, does not open run modal, and shows API error | `tests/playwright-agent-mission-empty-response.cjs` | Fixed: `src/App.tsx` |
| Agent cards | Card / `선택` | Selects selectable agent and updates active card state | `tests/playwright-agent-surface-buttons.cjs` | Verified |
| Agent cards | Profile readiness labels | Shows ready profiles and hides missing/deleted profiles from grid and runs | `tests/playwright-agent-profile-status.cjs` | Verified |
| Agent create | `+ 새 에이전트` / emoji / `만들기` success | Creates agent, closes modal, hydrates new card, and allows selecting it for mission launch | `tests/playwright-agent-surface-buttons.cjs` | Verified |
| Agent create | Failure response | Rolls back optimistic card and preserves modal inputs | `tests/playwright-agent-create-failure-rollback.cjs` | Verified |
| Agent create | Empty success response | Rolls back optimistic card and preserves modal inputs | `tests/playwright-agent-create-empty-response.cjs` | Fixed: `src/App.tsx` |
| Runs | Run row click | Opens run detail modal for the clicked run | `tests/playwright-agent-surface-buttons.cjs` | Verified |

## Widgets Screen / Native Widget Actions

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Widgets nav/action | `openScreen` widget action | Opens Widgets screen and clears consumed native action id | `tests/playwright-widget-actions.cjs` | Verified |
| Native widget | Task toggle action | Patches task done status through `/api/tasks/:id` and clears action id | `tests/playwright-widget-actions.cjs`, `tests/macos-widget-contract.test.mjs` | Verified |
| Native widget | Run open action | Opens run detail modal for requested run | `tests/playwright-widget-actions.cjs` | Verified |
| Native widget | Date open action | Opens a dated task context without error and clears action id | `tests/playwright-widget-open-task-date.cjs` | Verified |
| Native widget | Task open action | Opens task detail modal for requested task | `tests/playwright-widget-open-task-date.cjs` | Verified |
| Native widget contract | Widget families and AppIntent actions | Native WidgetKit project exposes month, today, next event, agent status, and inline intents | `tests/macos-widget-contract.test.mjs` | Verified |

## Settings / Login

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Profile | Profile button | Opens settings overlay | `tests/playwright-settings-overlay.cjs` | Verified |
| Settings | Theme buttons | Persists selected theme and updates app theme; rolls back on failure | `tests/playwright-settings-overlay.cjs`, `tests/playwright-settings-theme-failure.cjs` | Verified |
| Settings | Preference switches | Toggles preference and sends `/api/settings` payload | `tests/playwright-settings-overlay.cjs`, `tests/playwright-settings-prefs-empty-response.cjs` | Verified |
| Settings | `로그아웃` | Closes settings and shows login overlay | `tests/playwright-settings-overlay.cjs`, `tests/playwright-login-actions.cjs` | Verified |
| Settings | `완료` / close | Closes settings overlay | `tests/playwright-settings-overlay.cjs` | Verified |
| Login overlay | Email/password submit | Logs in, clears password, and closes overlay | `tests/playwright-settings-overlay.cjs` | Verified |
| Login overlay | Recovery button | Shows recovery notice | `tests/playwright-login-actions.cjs` | Verified |
| Login overlay | Apple / Google buttons | Closes login overlay without API error | `tests/playwright-login-actions.cjs` | Verified |

## Chat Drawer

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Floating button | Open / close console | Opens chat drawer; drawer close button hides it | `tests/playwright-chat-send.cjs`, `tests/playwright-chat-surface-buttons.cjs` | Verified |
| Chips | Suggested prompt chip | Copies chip text into chat input | `tests/playwright-chat-surface-buttons.cjs` | Verified |
| Run cards | Chat run card | Opens run detail modal for selected run | `tests/playwright-chat-surface-buttons.cjs` | Verified |
| Send | `전송` button | Streams response, appends user/assistant messages, and clears input on success | `tests/playwright-chat-send.cjs` | Verified |
| Send | Enter key | Sends message without inserting newline | `tests/playwright-chat-surface-buttons.cjs` | Verified |
| Send | Stream failure | Keeps original input and shows failure message | `tests/playwright-chat-send-failure-preserves-input.cjs` | Verified |

## Shared Modals / Hidden Screens

| Area | Button / interaction | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| New task modal | Checklist add / check / submit | Persists checklist markdown into created calendar event notes | `tests/playwright-new-task-checklist.cjs` | Verified |
| New task modal | Create failure | Keeps input open and reports API failure | `tests/playwright-new-task-create-failure.cjs` | Verified |
| New task modal | Calendar stale hydrate | Keeps created calendar event visible after delayed hydrate | `tests/playwright-new-task-calendar-stale-hydrate.cjs` | Verified |
| Delegate modal | Agent selector / `위임하고 실행` | Creates delegated task, launches mission with selected agent, opens run modal | `tests/playwright-delegate-submit.cjs` | Verified |
| Delegate modal | Task create failure | Does not launch mission after delegated task create fails | `tests/playwright-delegate-task-create-failure.cjs` | Verified |
| Delegate modal | Launch failure | Preserves delegate modal context and shows API error | `tests/playwright-delegate-launch-failure.cjs` | Verified |
| Run modal | Artifact `열기 →` empty response | Shows document identity error and keeps run modal context | `tests/playwright-run-artifact-empty-response.cjs` | Verified |
| Taxonomy manager | Create / edit / hide | Persists list/tag metadata through task API and updates nav | `tests/playwright-taxonomy-edit-hide.cjs`, `tests/playwright-taxonomy-create-empty-response-hydrates.cjs` | Verified |
| Taxonomy manager | Create failure / empty response | Rolls back optimistic nav and preserves taxonomy modal inputs | `tests/playwright-taxonomy-create-failure.cjs`, `tests/playwright-taxonomy-create-empty-response.cjs` | Verified |
| Taxonomy manager | Hide failure | Restores hidden nav item and selected screen | `tests/playwright-taxonomy-hide-failure-restore.cjs` | Verified |
| Notes screen | `notes` screen id | Present in code but not exposed in the current sidebar; document opening is handled through Search/Wiki reader instead | `src/App.tsx`, `tests/playwright-search-doc-open.cjs` | Not directly reachable |
| Someday screen | `someday` screen id | Present as task-list filter but not exposed in the current sidebar | `src/App.tsx` | Not directly reachable |
