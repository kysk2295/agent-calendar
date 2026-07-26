import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/api/hermesApi.ts', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const viteConfigSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const workspaceSource = readFileSync(new URL('../src/features/agent-operations/AgentWorkWorkspace.tsx', import.meta.url), 'utf8');
const uiPreferencesSource = readFileSync(new URL('../src/features/settings/uiPreferences.ts', import.meta.url), 'utf8');
const workManagementSource = readFileSync(new URL('../src/domains/work-management/workManagement.ts', import.meta.url), 'utf8');
const agentRosterSource = readFileSync(new URL('../src/domains/agent-work/agentRoster.ts', import.meta.url), 'utf8');
const communicationDomainSource = readFileSync(new URL('../src/domains/communication/communication.ts', import.meta.url), 'utf8');
const chatDrawerSource = readFileSync(new URL('../src/features/communication/ChatDrawer.tsx', import.meta.url), 'utf8');
const mailScreenSource = readFileSync(new URL('../src/features/communication/MailScreen.tsx', import.meta.url), 'utf8');
const wikiScreenSource = readFileSync(new URL('../src/features/knowledge/WikiScreen.tsx', import.meta.url), 'utf8');
const wikiGraphPanelSource = readFileSync(new URL('../src/features/knowledge/WikiGraphPanel.tsx', import.meta.url), 'utf8');
const wikiReaderSource = readFileSync(new URL('../src/features/knowledge/WikiReader.tsx', import.meta.url), 'utf8');
const diaryScreenSource = readFileSync(new URL('../src/features/knowledge/DiaryScreen.tsx', import.meta.url), 'utf8');
const notesScreenSource = readFileSync(new URL('../src/features/knowledge/NotesScreen.tsx', import.meta.url), 'utf8');
const reviewScreenSource = readFileSync(new URL('../src/features/knowledge/ReviewScreen.tsx', import.meta.url), 'utf8');
const knowledgeDomainSource = [
  '../src/domains/knowledge/documents.ts',
  '../src/domains/knowledge/graphEdges.ts',
  '../src/domains/knowledge/graphLayout.ts',
  '../src/domains/knowledge/journal.ts',
  '../src/domains/knowledge/knowledge.ts',
  '../src/domains/knowledge/primitives.ts',
  '../src/domains/knowledge/stream.ts',
  '../src/domains/knowledge/types.ts',
].map((sourcePath) => readFileSync(new URL(sourcePath, import.meta.url), 'utf8')).join('\n');
const communicationContractSource = [appSource, communicationDomainSource, chatDrawerSource, mailScreenSource].join('\n');
const knowledgeContractSource = [appSource, knowledgeDomainSource, wikiScreenSource, wikiGraphPanelSource, wikiReaderSource, diaryScreenSource, notesScreenSource, reviewScreenSource].join('\n');
const extractedContractSource = [knowledgeContractSource, communicationDomainSource, chatDrawerSource, mailScreenSource].join('\n');

test('browser preview proxy never acts as an owner-authorized confused deputy', () => {
  // Given / When / Then
  assert.doesNotMatch(viteConfigSource, /AGENT_CALENDAR_DEV_API_TOKEN/);
  assert.doesNotMatch(viteConfigSource, /Application Support['"],\s*['"]Agent Calendar['"],\s*['"]settings\.json/);
  assert.doesNotMatch(viteConfigSource, /authorization:\s*`Bearer \$\{apiProxyToken\}`/);
});

test('long Agent Operations requests use a terminal timeout while run-now only waits for acceptance', () => {
  assert.match(apiSource, /const AGENT_OPERATIONS_TIMEOUT_MS = 400_000/);
  assert.match(apiSource, /getAgentOperations: \(\) => hermesJson<unknown>\('\/api\/agent-operations', undefined, AGENT_OPERATIONS_TIMEOUT_MS\)/);
  assert.match(apiSource, /planAgentMission:[\s\S]*AGENT_OPERATIONS_TIMEOUT_MS/);
  assert.doesNotMatch(apiSource, /tickAgentOperations|\/api\/agent-operations\/tick/);
  assert.match(apiSource, /runAgentTaskNow:[^\n]+body: '\{\}' \}\),/);
  assert.doesNotMatch(apiSource, /runAgentTaskNow:[^\n]+AGENT_OPERATIONS_TIMEOUT_MS/);
});

test('Desktop does not expose the retired direct Workboard conversion', () => {
  assert.doesNotMatch(apiSource, /convertWorkboard|\/api\/workboard\/convert/);
  assert.match(apiSource, /createAgentWork:[^\n]+\/api\/agent-operations\/work/);
});

test('agent work state refreshes independently of unrelated application hydration failures', () => {
  assert.doesNotMatch(appSource, /return agentOperations;/);
  assert.match(
    appSource,
    /\.then\(parseAgentOperationsEnvelope\)\s*\.then\(\(next\) => \{\s*if \(!isHydrationCurrent\(\)\) return null;\s*setAgentOperations\(next\);/,
  );
  assert.doesNotMatch(appSource, /chatRequest,\s*agentOperationsRequest/);
});

test('unrelated optional API failures do not cover the independent Work Conversation view', () => {
  assert.match(appSource, /const showGlobalApiBanner = Boolean\(/);
  assert.match(appSource, /screen !== 'agents'/);
  assert.match(
    appSource,
    /!\['offline', 'reconnecting'\]\.includes\(desktopConnectivity\.status\)/,
  );
  assert.match(appSource, /data-testid="desktop-connectivity"/);
  assert.match(appSource, /\{showGlobalApiBanner && <div className="api-banner">/);
  assert.match(
    appSource,
    /\{showDesktopConnectivity \? '연결 확인 필요' : showGlobalApiBanner \? 'Railway 확인 필요' : accountProviderLabel\}/,
  );
});

test('fresh aggregate mission state wins over a stale Work Conversation snapshot after a control action', () => {
  assert.match(workspaceSource, /status:\s*selectedBaseMission\.status,/);
  assert.doesNotMatch(workspaceSource, /status:\s*selectedConversation\.work\.status,/);
});

test('calendar renders only Railway tasks/events for a date, never fallback filler rows', () => {
  assert.equal(appSource.includes('calendarItems.slice(fallbackIndex'), false);
  assert.equal(appSource.includes('matched.length ? matched : calendarItems.slice'), false);
});

test('desktop calendar keeps event details instead of switching to compressed mobile pills', () => {
  assert.match(styleSource, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.month-grid\s*\{[\s\S]*?repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(styleSource, /\.event-pill b\s*\{\s*display:\s*none/);
});

test('wiki answers expose each cited source as an openable document control', () => {
  assert.match(wikiScreenSource, /className="wiki-answer-sources"/);
  assert.match(wikiScreenSource, /aria-label=\{`출처 열기: \$\{sourceTitle\}`\}/);
  assert.match(wikiScreenSource, /source\.excerpt/);
  assert.match(wikiScreenSource, /setActiveWikiId\(sourceId\);\s*setReaderOpen\(true\)/);
  assert.match(appSource, /screen === 'wiki' && <WikiScreen[^\n]+sources=\{wikiAnswerSources\}/);
});

test('knowledge screens receive document loading through the App composition boundary', () => {
  assert.doesNotMatch(`${wikiScreenSource}\n${diaryScreenSource}`, /hermesApi/);
  assert.match(appSource, /function loadKnowledgeDocument\(/);
  assert.match(appSource, /<WikiScreen[^\n]+loadDocument=\{loadKnowledgeDocument\}/);
  assert.match(appSource, /<DiaryScreen[^\n]+loadDocument=\{loadKnowledgeDocument\}/);
});

test('hydrate does not mask failed backend endpoints with dashboard fallback data', () => {
  assert.doesNotMatch(appSource, /Promise\.allSettled/);
  assert.doesNotMatch(appSource, /result\.status === 'fulfilled' \? result\.value : \{\}/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'tasks'\)/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'agents'\)/);
  assert.doesNotMatch(knowledgeContractSource, /arr\(dashboard,\s*'documents'/);
  assert.doesNotMatch(communicationContractSource, /arr\(dashboard,\s*'chatMessages'\)/);
  assert.doesNotMatch(appSource, /arr\(dashboard,\s*'schedulerJobs'\)/);
  assert.doesNotMatch(communicationContractSource, /arr\(dashboard,\s*'mailMessages'\)/);
});

test('app does not create client-side seed or local optimistic task/run data', () => {
  assert.doesNotMatch(extractedContractSource, /const seedTasks/);
  assert.doesNotMatch(extractedContractSource, /const seedMail/);
  assert.doesNotMatch(extractedContractSource, /localTasks/);
  assert.doesNotMatch(extractedContractSource, /localEvents/);
  assert.doesNotMatch(extractedContractSource, /addLocalTask/);
  assert.doesNotMatch(extractedContractSource, /taskOverrides/);
  assert.doesNotMatch(extractedContractSource, /eventOverrides/);
  assert.doesNotMatch(extractedContractSource, /deletedTaskIds/);
  assert.doesNotMatch(extractedContractSource, /deletedEventIds/);
  assert.doesNotMatch(extractedContractSource, /setTaskOverrides/);
  assert.doesNotMatch(extractedContractSource, /setEventOverrides/);
  assert.doesNotMatch(extractedContractSource, /id:\s*`chat-run-/);
  assert.doesNotMatch(extractedContractSource, /id:\s*`draft-/);
  assert.doesNotMatch(extractedContractSource, /id:\s*`local-/);
  assert.doesNotMatch(extractedContractSource, /id:\s*`plan-/);
  assert.doesNotMatch(extractedContractSource, /runs: \[localRun/);
  assert.doesNotMatch(extractedContractSource, /const baseAgents = state\.agents\.length \? state\.agents :/);
  assert.doesNotMatch(extractedContractSource, /run-local/);
  assert.doesNotMatch(extractedContractSource, /customAgents/);
  assert.doesNotMatch(extractedContractSource, /localTaxonomy/);
});

test('chat drawer starts from backend chat history, not a client-side greeting', () => {
  assert.doesNotMatch(communicationContractSource, /Hermes 콘솔 준비됨/);
  assert.doesNotMatch(communicationContractSource, /useState<Array<\{ role: string; text: string \}>>\(\[\s*\{/);
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
  assert.match(workManagementSource, /recordId\?:\s*string/);
  assert.match(appSource, /function updateTaxonomy\(/);
  assert.match(appSource, /function hideTaxonomy\(/);
  assert.match(appSource, /hermesApi\.updateTask\(item\.recordId/);
  assert.match(appSource, /hidden:\s*true/);
  assert.match(appSource, /className="taxonomy-manager"/);
});

test('calendar CRUD persists duration, all-day, and recurrence through Railway event fields', () => {
  assert.match(workManagementSource, /const CALENDAR_META_MARKER/);
  assert.match(workManagementSource, /function calendarMetadata\(/);
  assert.match(workManagementSource, /function calendarNotes\(/);
  assert.match(workManagementSource, /payload\.recurrence\s*=/);
  assert.match(workManagementSource, /payload\.allDay\s*=/);
  assert.match(workManagementSource, /payload\.endDate\s*=/);
  assert.match(workManagementSource, /payload\.endTime\s*=/);
  assert.match(appSource, /const patchItem = isEvent \? patchCalendarEvent : patchTask/);
  assert.match(appSource, /function TaskDetailModal\(/);
  assert.match(appSource, /const patchEnd = \(patch: Item\)/);
  assert.match(appSource, /patchEnd\(\{\s*allDay:/);
  assert.match(appSource, /const \[durationDraft, setDurationDraft\]/);
  assert.match(appSource, /const commitDurationDraft =/);
  assert.match(appSource, /endDate: next\.endDate/);
});

test('task surfaces exclude calendar-only event records', () => {
  assert.match(workManagementSource, /function isCalendarEventRecord\(/);
  assert.match(workManagementSource, /function isTaskRecord\(/);
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
  assert.doesNotMatch(knowledgeContractSource, /wikiRag/);
  assert.doesNotMatch(knowledgeContractSource, /answerWikiQuestion/);
  assert.doesNotMatch(knowledgeContractSource, /buildWikiRagContext/);
  assert.doesNotMatch(knowledgeContractSource, /위키 기반 요약입니다\. 관련 문서와 최근 작업을 함께 검토하세요/);
  assert.match(wikiGraphPanelSource, /const \[graphZoom,\s*setGraphZoom\]/);
  assert.match(wikiGraphPanelSource, /const \[graphPan,\s*setGraphPan\]/);
  assert.match(wikiGraphPanelSource, /onWheel=\{/);
  assert.match(wikiGraphPanelSource, /wiki-graph-controls/);
  assert.match(appSource, /screen === 'wiki' && <WikiScreen/);
});

test('diary and review writes are persisted through backend documents API', () => {
  assert.match(apiSource, /createDocument:/);
  assert.match(apiSource, /\/api\/documents/);
  assert.match(appSource, /async function saveDiary\(/);
  assert.match(appSource, /async function saveRetro\(/);
  assert.match(appSource, /hermesApi\.createDocument/);
  assert.doesNotMatch(knowledgeContractSource, /setLocalDocs/);
  assert.doesNotMatch(knowledgeContractSource, /diary-seed/);
  assert.match(diaryScreenSource, /onClick=\{saveDiary\}/);
  assert.match(reviewScreenSource, /saveRetro\(retro\)/);
});

test('weekly review auto draft is generated by backend LLM instead of a client template', () => {
  assert.match(appSource, /async function generateRetroDraft\(/);
  assert.match(appSource, /hermesApi\.askWiki/);
  assert.match(appSource, /async function createReviewGoal\(/);
  assert.match(appSource, /hermesApi\.createTask/);
  assert.match(appSource, /createReviewGoal=\{createReviewGoal\}/);
  assert.match(reviewScreenSource, /generateRetroDraft\(\{/);
  assert.match(reviewScreenSource, /createReviewGoal\(value\)/);
  assert.doesNotMatch(knowledgeContractSource, /setRetro\(`📅/);
  assert.doesNotMatch(knowledgeContractSource, /2026\.06\.23 - 2026\.06\.29 주간 회고/);
  assert.doesNotMatch(knowledgeContractSource, /반복되는 정리 작업을 Hermes에게 넘겨/);
  assert.doesNotMatch(knowledgeContractSource, /UniPort 백로그 정리/);
  assert.doesNotMatch(knowledgeContractSource, /에이전트 위임 루프 안정화/);
  assert.doesNotMatch(knowledgeContractSource, /트레이딩 규칙 회고/);
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
  assert.match(styleSource, /\.detail-topline \.detail-check\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*background:\s*var\(--input\);[^}]*border:\s*1\.5px solid var\(--line-strong\);[^}]*border-radius:\s*2px/s);
  assert.match(styleSource, /\.detail-topline \.detail-check\[data-done="true"\]\s*\{[^}]*background:\s*var\(--input\);[^}]*border-color:\s*var\(--line-strong\)/s);
  assert.match(styleSource, /\.new-task-check-row input\[type="checkbox"\]\s*\{[^}]*appearance:\s*none;[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*background:\s*#FFFFFF;[^}]*border:\s*1\.5px solid #9A9A9A;[^}]*border-radius:\s*2px/s);
});

test('mail is a truthful read and Workspace task-delegation surface', () => {
  assert.match(apiSource, /getMailMessages:/);
  assert.doesNotMatch(apiSource, /saveMailAccount:|syncMail:|runMailAction:/);
  assert.doesNotMatch(apiSource, /\/api\/mail\/accounts|\/api\/mail\/sync|\/api\/mail\/messages\/\$\{/);
  assert.doesNotMatch(apiSource, /getInbox:|runInboxCommand:/);
  assert.match(appSource, /async function addTaskFromMail\(/);
  assert.match(appSource, /hermesApi\.createTask\(\{[\s\S]*source:\s*'desktop-mail'[\s\S]*sourceMailId:\s*id/);
  assert.doesNotMatch(appSource, /function connectGmail\(|async function archiveMail\(|async function toggleMailStar\(/);
  assert.doesNotMatch(communicationDomainSource, /gmailAccountInput|normalizeGmailSyncResponse|optimisticMailArchiveUpdate|optimisticMailStarUpdate/);
  assert.match(mailScreenSource, /className="mail-connection-note"/);
  assert.match(mailScreenSource, /onClick=\{\(\) => addTaskFromMail\(active\)\}/);
  assert.match(mailScreenSource, /onClick=\{reloadMail\}/);
  assert.doesNotMatch(mailScreenSource, /type="password"|Google 앱 비밀번호|aria-label="별표"|>보관<\/button>/);
  assert.doesNotMatch(communicationContractSource, /archivedMailIds/);
  assert.doesNotMatch(communicationContractSource, /mailTaskIds/);
  assert.doesNotMatch(communicationContractSource, /mailStarIds/);
  assert.doesNotMatch(communicationContractSource, /setArchivedMailIds/);
  assert.doesNotMatch(communicationContractSource, /setMailTaskIds/);
  assert.doesNotMatch(communicationContractSource, /setMailStarIds/);
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
  assert.match(appSource, /id:\s*'widgets',\s*icon:\s*'widget',\s*label:\s*'위젯'/);
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
  assert.doesNotMatch(`${workManagementSource}\n${agentRosterSource}`, /marketflow/i);
  assert.match(workManagementSource, /bizconsultant/);
  assert.match(workManagementSource, /wikicurator/);
});

test('wiki answer sends the unchanged question to wikicurator without a client prompt', () => {
  assert.match(appSource, /message:\s*question/);
  assert.doesNotMatch(knowledgeContractSource, /wikiStreamCommand|SOURCES만 사용|최소\s*350자|5~9문장/);
});

test('agent cards use Hermes dashboard profile readiness instead of idle fallback labels', () => {
  assert.match(appSource, /profileReadiness:\s*obj\(dashboard,\s*'profileReadiness'\)/);
  assert.match(appSource, /mergeAgentsWithProfileReadiness\(state\.agents,\s*state\.profileReadiness\)/);
  assert.match(agentRosterSource, /function agentStatusLabel\(/);
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

test('settings preferences use Electron persistence before the remote preview fallback', () => {
  assert.match(apiSource, /saveSettings:/);
  assert.match(apiSource, /\/api\/settings/);
  assert.match(appSource, /async function updatePrefs\(/);
  assert.match(appSource, /saveLocal:\s*desktopApi/);
  assert.match(appSource, /saveRemote:\s*\(payload\) => hermesApi\.saveSettings\(payload\)/);
  assert.match(appSource, /localUiPreferencesRef\.current \|\| readUiPreferences\(settingsPayload\)/);
  assert.match(uiPreferencesSource, /saveLocal\s*\? await saveLocal/);
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
