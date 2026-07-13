import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/api/hermesApi.ts', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const viteConfigSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

test('browser preview proxy authenticates with the local desktop Railway token', () => {
  assert.match(viteConfigSource, /AGENT_CALENDAR_DEV_API_TOKEN/);
  assert.match(viteConfigSource, /Application Support['"],\s*['"]Agent Calendar['"],\s*['"]settings\.json/);
  assert.match(viteConfigSource, /authorization:\s*`Bearer \$\{apiProxyToken\}`/);
});

test('Agent Operations requests allow the backend profile run to reach its terminal state', () => {
  assert.match(apiSource, /const AGENT_OPERATIONS_TIMEOUT_MS = 400_000/);
  assert.match(apiSource, /planAgentMission:[\s\S]*AGENT_OPERATIONS_TIMEOUT_MS/);
  assert.match(apiSource, /tickAgentOperations:[\s\S]*AGENT_OPERATIONS_TIMEOUT_MS/);
});

test('calendar renders only Railway tasks/events for a date, never fallback filler rows', () => {
  assert.equal(appSource.includes('calendarItems.slice(fallbackIndex'), false);
  assert.equal(appSource.includes('matched.length ? matched : calendarItems.slice'), false);
});

test('narrow calendar keeps persisted event pills visible for inspection and editing', () => {
  assert.doesNotMatch(styleSource, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.event-pill\s*\{\s*display:\s*none/);
  assert.match(styleSource, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.event-pill\s*\{[\s\S]*?font-size:/);
});

test('wiki answers expose each cited source as an openable document control', () => {
  assert.match(appSource, /className="wiki-answer-sources"/);
  assert.match(appSource, /aria-label=\{`출처 열기: \$\{sourceTitle\}`\}/);
  assert.match(appSource, /source\.excerpt/);
  assert.match(appSource, /setActiveWikiId\(sourceId\);\s*setReaderOpen\(true\)/);
});

test('hydrate does not mask failed backend endpoints with dashboard fallback data', () => {
  assert.doesNotMatch(appSource, /Promise\.allSettled/);
  assert.doesNotMatch(appSource, /result\.status === 'fulfilled' \? result\.value : \{\}/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'tasks'\)/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'agents'\)/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'documents'/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'chatMessages'\)/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'schedulerJobs'\)/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'mailMessages'\)/);
});

test('app does not create client-side seed or local optimistic task/run data', () => {
  assert.doesNotMatch(appSource, /const seedTasks/);
  assert.doesNotMatch(appSource, /const seedMail/);
  assert.doesNotMatch(appSource, /localTasks/);
  assert.doesNotMatch(appSource, /localEvents/);
  assert.doesNotMatch(appSource, /addLocalTask/);
  assert.doesNotMatch(appSource, /taskOverrides/);
  assert.doesNotMatch(appSource, /eventOverrides/);
  assert.doesNotMatch(appSource, /deletedTaskIds/);
  assert.doesNotMatch(appSource, /deletedEventIds/);
  assert.doesNotMatch(appSource, /setTaskOverrides/);
  assert.doesNotMatch(appSource, /setEventOverrides/);
  assert.doesNotMatch(appSource, /id:\s*`chat-run-/);
  assert.doesNotMatch(appSource, /id:\s*`draft-/);
  assert.doesNotMatch(appSource, /id:\s*`local-/);
  assert.doesNotMatch(appSource, /id:\s*`plan-/);
  assert.doesNotMatch(appSource, /runs: \[localRun/);
  assert.doesNotMatch(appSource, /const baseAgents = state\.agents\.length \? state\.agents :/);
  assert.doesNotMatch(appSource, /run-local/);
  assert.doesNotMatch(appSource, /customAgents/);
  assert.doesNotMatch(appSource, /localTaxonomy/);
});

test('chat drawer starts from backend chat history, not a client-side greeting', () => {
  assert.doesNotMatch(appSource, /Hermes 콘솔 준비됨/);
  assert.doesNotMatch(appSource, /useState<Array<\{ role: string; text: string \}>>\(\[\s*\{/);
});

test('calendar-created work is persisted as calendar events, not tasks', () => {
  assert.match(appSource, /hermesApi\.createCalendarEvent\(/);
  assert.match(appSource, /hermesApi\.updateCalendarEvent\(/);
  assert.match(appSource, /hermesApi\.deleteCalendarEvent\(/);
  assert.doesNotMatch(appSource, /hermesApi\.updateTask\(remoteId,\s*patch\)/);
  assert.doesNotMatch(appSource, /source:\s*'calendar'/);
  assert.match(apiSource, /createCalendarEvent:/);
  assert.match(apiSource, /updateCalendarEvent:/);
  assert.match(apiSource, /deleteCalendarEvent:/);
  assert.match(apiSource, /\/api\/calendar\/events/);
});

test('desktop task mutations use the native Hermes database only', () => {
  assert.equal(appSource.includes('hermesApi.updateTask(id, taskPayload(snapshot))'), true);
  assert.equal(appSource.includes('hermesApi.deleteTask(id)'), true);
  assert.doesNotMatch(appSource, /scheduleTaskPatch/);
  assert.doesNotMatch(appSource, /scheduleEventPatch/);
});

test('desktop list and tag metadata are persisted to Railway metadata records', () => {
  assert.match(appSource, /source:\s*TAXONOMY_SOURCE/);
  assert.match(appSource, /taxonomyKind:\s*item\.kind/);
});

test('desktop taxonomy can be edited and hidden through Railway metadata records', () => {
  assert.match(appSource, /recordId\?:\s*string/);
  assert.match(appSource, /function updateTaxonomy\(/);
  assert.match(appSource, /function hideTaxonomy\(/);
  assert.match(appSource, /hermesApi\.updateTask\(item\.recordId/);
  assert.match(appSource, /hidden:\s*true/);
  assert.match(appSource, /className="taxonomy-manager"/);
});

test('calendar CRUD persists duration, all-day, and recurrence through Railway event fields', () => {
  assert.match(appSource, /const CALENDAR_META_MARKER/);
  assert.match(appSource, /function calendarMetadata\(/);
  assert.match(appSource, /function calendarNotes\(/);
  assert.match(appSource, /payload\.recurrence\s*=/);
  assert.match(appSource, /payload\.allDay\s*=/);
  assert.match(appSource, /payload\.endDate\s*=/);
  assert.match(appSource, /payload\.endTime\s*=/);
  assert.match(appSource, /const patchItem = isEvent \? patchCalendarEvent : patchTask/);
  assert.match(appSource, /function TaskDetailModal\(/);
  assert.match(appSource, /const patchEnd = \(patch: Item\)/);
  assert.match(appSource, /patchEnd\(\{\s*allDay:/);
  assert.match(appSource, /const \[durationDraft, setDurationDraft\]/);
  assert.match(appSource, /const commitDurationDraft =/);
  assert.match(appSource, /endDate: next\.endDate/);
});

test('task surfaces exclude calendar-only event records', () => {
  assert.match(appSource, /function isCalendarEventRecord\(/);
  assert.match(appSource, /function isTaskRecord\(/);
  assert.match(appSource, /rawTasks\.filter\(isTaskRecord\)/);
  assert.match(appSource, /const scheduledTaskItems = filteredTasks\.filter/);
});

test('wiki graph is interactive and wiki ask uses Railway LLM endpoint', () => {
  const wikiAskSource = appSource.slice(
    appSource.indexOf('async function askWiki()'),
    appSource.indexOf('function dismissWikiAnswer()'),
  );
  assert.match(apiSource, /askWiki:/);
  assert.match(apiSource, /\/api\/wiki\/ask/);
  assert.match(apiSource, /const WIKI_SEARCH_TIMEOUT_MS = 60_000/);
  assert.match(apiSource, /searchWiki: \(body: Record<string, unknown>\) => jsonPost\('\/api\/wiki\/search', body, WIKI_SEARCH_TIMEOUT_MS\)/);
  assert.match(appSource, /function askWiki\(/);
  assert.doesNotMatch(wikiAskSource, /path:\s*activeWikiId/);
  assert.doesNotMatch(appSource, /wikiRag/);
  assert.doesNotMatch(appSource, /answerWikiQuestion/);
  assert.doesNotMatch(appSource, /buildWikiRagContext/);
  assert.doesNotMatch(appSource, /위키 기반 요약입니다\. 관련 문서와 최근 작업을 함께 검토하세요/);
  assert.match(appSource, /const \[graphZoom,\s*setGraphZoom\]/);
  assert.match(appSource, /const \[graphPan,\s*setGraphPan\]/);
  assert.match(appSource, /onWheel=\{/);
  assert.match(appSource, /wiki-graph-controls/);
});

test('diary and review writes are persisted through backend documents API', () => {
  assert.match(apiSource, /createDocument:/);
  assert.match(apiSource, /\/api\/documents/);
  assert.match(appSource, /async function saveDiary\(/);
  assert.match(appSource, /async function saveRetro\(/);
  assert.match(appSource, /hermesApi\.createDocument/);
  assert.doesNotMatch(appSource, /setLocalDocs/);
  assert.doesNotMatch(appSource, /diary-seed/);
});

test('weekly review auto draft is generated by backend LLM instead of a client template', () => {
  assert.match(appSource, /async function generateRetroDraft\(/);
  assert.match(appSource, /hermesApi\.askWiki/);
  assert.match(appSource, /async function createReviewGoal\(/);
  assert.match(appSource, /hermesApi\.createTask/);
  assert.match(appSource, /createReviewGoal=\{createReviewGoal\}/);
  assert.doesNotMatch(appSource, /setRetro\(`📅/);
  assert.doesNotMatch(appSource, /2026\.06\.23 - 2026\.06\.29 주간 회고/);
  assert.doesNotMatch(appSource, /반복되는 정리 작업을 Hermes에게 넘겨/);
  assert.doesNotMatch(appSource, /UniPort 백로그 정리/);
  assert.doesNotMatch(appSource, /에이전트 위임 루프 안정화/);
  assert.doesNotMatch(appSource, /트레이딩 규칙 회고/);
});

test('sidebar removes fixed mock note and someday tabs and topbar search', () => {
  assert.equal(appSource.includes("navKey: 'list:notes'"), false);
  assert.equal(appSource.includes("navKey: 'list:someday'"), false);
  assert.equal(appSource.includes('className="top-search"'), false);
});

test('list editor uses modal emoji picker and preserves folder-edit image pattern', () => {
  assert.match(appSource, /type ModalId = .*'taxonomy'/);
  assert.match(appSource, /function TaxonomyModal\(/);
  assert.match(appSource, /className="emoji-picker"/);
  assert.match(appSource, /className="taxonomy-modal"/);
  assert.equal(appSource.includes('onFocus={() => setPickerOpen(true)}'), false);
});

test('task completion toggles local UI immediately and rolls back on persistence failure', () => {
  assert.doesNotMatch(appSource, /completingTaskIds/);
  assert.doesNotMatch(appSource, /setTimeout\(\(\) => patchTask\(task,\s*\{\s*status:\s*'Done'/);
  assert.doesNotMatch(appSource, /<div className="task-row"[^>]+data-completing/);
  assert.match(appSource, /function applyOptimisticTaskPatch/);
  assert.match(appSource, /function applyOptimisticEventPatch/);
  assert.match(appSource, /patchTask\(task,\s*\{\s*status:\s*done \? 'Done' : 'Planned',\s*done\s*\}/);
  assert.match(appSource, /applyOptimisticTaskPatch\(id,\s*snapshot\)/);
  assert.match(appSource, /applyOptimisticTaskPatch\(id,\s*task\)/);
});

test('calendar detail checkbox completes calendar event records through calendar API', () => {
  assert.match(appSource, /const toggleDetailCompletion = async \(\) => \{/);
  assert.match(appSource, /setCompletionOverride\(selectedId \? \{ id: selectedId, done \} : null\)/);
  assert.match(appSource, /patchCalendarEvent\(detailTask,\s*\{\s*status:\s*done \? 'Done' : 'Planned',\s*done\s*\}\)/);
  assert.match(appSource, /applyOptimisticEventPatch\(id,\s*snapshot\)/);
  assert.match(appSource, /<button className="detail-check" data-done=\{isDone\(detailTask\)\} data-completing=\{completionPulse\}/);
  assert.match(appSource, /aria-expanded=\{dateOpen\}/);
  assert.match(appSource, /<SystemIcon name="calendar" className="detail-date-icon" \/>/);
  assert.doesNotMatch(appSource, /\{!isEvent && <button className="detail-check"/);
});

test('task completion checkboxes match TickTick empty-square size', () => {
  assert.match(styleSource, /\.row i\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*background:\s*#FFFFFF;[^}]*border:\s*1\.5px solid #9A9A9A;[^}]*border-radius:\s*2px/s);
  assert.match(styleSource, /\.row\[data-done="true"\] i\s*\{[^}]*background:\s*#FFFFFF;[^}]*border-color:\s*#9A9A9A/s);
  assert.match(styleSource, /\.task-inspector header \.detail-check\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*background:\s*#FFFFFF;[^}]*border:\s*1\.5px solid #9A9A9A;[^}]*border-radius:\s*2px/s);
  assert.match(styleSource, /\.detail-topline \.detail-check\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*background:\s*#FFFFFF;[^}]*border:\s*1\.5px solid #9A9A9A;[^}]*border-radius:\s*2px/s);
  assert.match(styleSource, /\.detail-topline \.detail-check\[data-done="true"\]\s*\{[^}]*background:\s*#FFFFFF;[^}]*border-color:\s*#9A9A9A/s);
  assert.match(styleSource, /\.new-task-check-row input\[type="checkbox"\]\s*\{[^}]*appearance:\s*none;[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*background:\s*#FFFFFF;[^}]*border:\s*1\.5px solid #9A9A9A;[^}]*border-radius:\s*2px/s);
});

test('gmail mail connection is wired to Railway mail endpoints', () => {
  assert.match(apiSource, /saveMailAccount:/);
  assert.match(apiSource, /syncMail:/);
  assert.match(apiSource, /runInboxCommand:/);
  assert.match(appSource, /function connectGmail\(/);
  assert.match(appSource, /async function addTaskFromMail\(/);
  assert.match(appSource, /async function archiveMail\(/);
  assert.match(appSource, /async function toggleMailStar\(/);
  assert.match(appSource, /hermesApi\.saveMailAccount/);
  assert.match(appSource, /hermesApi\.syncMail/);
  assert.match(appSource, /hermesApi\.runInboxCommand\(id,\s*'task'/);
  assert.match(appSource, /hermesApi\.runInboxCommand\(id,\s*'archive'/);
  assert.match(appSource, /hermesApi\.runInboxCommand\(id,\s*next \? 'star' : 'unstar'/);
  assert.match(appSource, /provider:\s*'gmail'/);
  assert.doesNotMatch(appSource, /archivedMailIds/);
  assert.doesNotMatch(appSource, /mailTaskIds/);
  assert.doesNotMatch(appSource, /mailStarIds/);
  assert.doesNotMatch(appSource, /setArchivedMailIds/);
  assert.doesNotMatch(appSource, /setMailTaskIds/);
  assert.doesNotMatch(appSource, /setMailStarIds/);
});

test('task list uses an inspector and scan-friendly rows', () => {
  assert.match(appSource, /function TaskInspectorPane\(/);
  assert.match(appSource, /className="list-screen task-list-screen/);
  assert.match(appSource, /className="task-due"/);
  assert.match(appSource, /만료됨/);
  assert.match(appSource, /연기하다/);
  assert.match(appSource, /onDoubleClick=\{\(\) => openTask\(task\)\}/);
});

test('widgets screen implements the handoff widget plan with live app data', () => {
  assert.match(appSource, /type ScreenId = .*'widgets'/);
  assert.match(appSource, /widgets:\s*\{\s*title:\s*'위젯'/);
  assert.match(appSource, /id:\s*'widgets',\s*icon:\s*'▣',\s*label:\s*'위젯'/);
  assert.match(appSource, /function WidgetsScreen\(/);
  assert.match(appSource, /className="widgets-showcase/);
  assert.match(appSource, /월 캘린더/);
  assert.match(appSource, /오늘 — Medium/);
  assert.match(appSource, /다음 일정/);
  assert.match(appSource, /에이전트 상태/);
  assert.match(appSource, /tasks=\{tasks\}\s+events=\{events\}\s+runs=\{runs\}/);
  assert.match(appSource, /widgetMonthCells/);
  assert.match(appSource, /widgetOwnerClass/);
});

test('delegate modal uses backend agents only and does not invent fallback agents', () => {
  assert.match(appSource, /const visibleAgents = agents\.filter\(isAgentSelectable\)\.slice\(0,\s*4\)/);
  assert.doesNotMatch(appSource, /agents\.length \? agents\.slice\(0,\s*4\) : \[/);
  assert.doesNotMatch(appSource, /id:\s*'researcher'/);
  assert.doesNotMatch(appSource, /name:\s*'리서처'/);
  assert.doesNotMatch(appSource, /name:\s*'플래너'/);
});

test('desktop task ownership recognizes live Hermes profiles without the removed profile', () => {
  assert.doesNotMatch(appSource, /marketflow/i);
  assert.match(appSource, /bizconsultant/);
  assert.match(appSource, /wikicurator/);
});

test('agent cards use Hermes dashboard profile readiness instead of idle fallback labels', () => {
  assert.match(appSource, /profileReadiness:\s*obj\(dashboard,\s*'profileReadiness'\)/);
  assert.match(appSource, /mergeAgentsWithProfileReadiness\(state\.agents,\s*state\.profileReadiness\)/);
  assert.match(appSource, /function agentStatusLabel\(/);
  assert.doesNotMatch(appSource, /statusLabel = \(agent: Item\).*'대기'/);
});

test('agent mission launch does not create a client-side plan draft', () => {
  assert.match(apiSource, /launchMission:/);
  assert.match(apiSource, /\/api\/missions\/launch/);
  assert.match(appSource, /async function startPlan\(/);
  assert.match(appSource, /hermesApi\.launchMission/);
  assert.doesNotMatch(appSource, /planDraft/);
  assert.doesNotMatch(appSource, /setPlanDraft/);
  assert.doesNotMatch(appSource, /PlanReview/);
  assert.doesNotMatch(appSource, /'목표 해석'/);
  assert.doesNotMatch(appSource, /'컨텍스트 수집'/);
  assert.doesNotMatch(appSource, /'위키 기록'/);
  assert.doesNotMatch(appSource, /요청을 분석하고 작업으로 변환/);
  assert.doesNotMatch(appSource, /에이전트가 계획을 수행 중/);
  assert.doesNotMatch(appSource, /artifact:\s*`\$\{textValue\.slice\(0,\s*34\)\} 결과 정리`/);
});

test('agent run approval is persisted through Railway run action API', () => {
  assert.match(apiSource, /approveRun:/);
  assert.match(apiSource, /\/api\/runs\/\$\{encodeURIComponent\(id\)\}\/approve/);
  assert.match(appSource, /async function approveRun\(/);
  assert.match(appSource, /hermesApi\.approveRun\(id\)/);
  assert.match(appSource, /runs:\s*current\.runs\.filter/);
  assert.match(appSource, /className="run-approve"/);
  assert.match(appSource, /onClick=\{\(\) => approveRun\(run\)\}/);
  assert.match(appSource, /approvedRunIdsRef/);
  assert.doesNotMatch(appSource, /\/404\/\.test\(message\)/);
  assert.doesNotMatch(appSource, /setApprovedRunIds/);
  assert.doesNotMatch(appSource, /Record<string,\s*true>/);
});

test('settings preferences are persisted through backend settings API', () => {
  assert.match(apiSource, /saveSettings:/);
  assert.match(apiSource, /\/api\/settings/);
  assert.match(appSource, /async function updatePrefs\(/);
  assert.match(appSource, /hermesApi\.saveSettings\(\{\s*uiPreferences:/);
  assert.match(appSource, /setPrefs\(settingsPreferences\(settingsPayload\)\)/);
  assert.doesNotMatch(appSource, /onClick=\{\(\) => setPrefs\(\{ \.\.\.prefs, \[key\]: !prefs\[key\] \}\)\}/);
});

test('settings preference rows keep oversized toggles inside the settings card', () => {
  assert.match(appSource, /className="pref-row"/);
  assert.match(appSource, /className="pref-copy"/);
  assert.match(styleSource, /\.pref-box \.pref-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*max-content/);
  assert.match(styleSource, /\.pref-box \.pref-copy\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styleSource, /\.pref-box \.switch\s*\{[\s\S]*justify-self:\s*end/);
});

test('new task date panel removes quick date shortcuts and accordion leading icons', () => {
  assert.doesNotMatch(appSource, /className="new-quick-dates"/);
  assert.doesNotMatch(appSource, /setQuickDate\(addDaysKey\(todayKey\(\), 1\)\).*내일/s);
  assert.doesNotMatch(appSource, /NewAccordionRow icon=/);
  assert.doesNotMatch(appSource, /function NewAccordionRow\(\{ icon,/);
  assert.doesNotMatch(appSource, /<span>\{icon\}<\/span>/);
});
