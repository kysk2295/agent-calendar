# Personal Agent Operations Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single-user Weekly Opportunity Brief flow from mission creation through agent-generated calendar work, persistent Codex-like Task Sessions, Mac mini Hermes execution, evidence-backed reporting, Telegram summary, and follow-up approval.

**Architecture:** Railway remains the durable control plane and the existing outbound Mac mini relay remains the execution plane. New focused CommonJS modules own agent-operation domain rules, persistence, Relay completion, scheduling, and API responses; the desktop app consumes those contracts through a typed feature package and renders Missions, Agents, Reports, Task Sessions, and calendar states without exposing raw runtime internals.

**Tech Stack:** Node.js CommonJS backend, PostgreSQL JSONB persistence, Railway outbound relay, Hermes OpenAI-compatible chat completions, React 18, TypeScript 5.7, Vite, Playwright, Node test runner.

---

## Source Specification

- `docs/superpowers/specs/2026-07-13-personal-agent-operations-calendar-design.md`

## Work Size And Boundaries

- Large / Boundary change.
- Backend gateway: `apps/backend/app/railway-gateway-server.js`, `apps/backend/app/lib/**`, `apps/backend/app/db/**`.
- Desktop renderer: `apps/desktop/src/**`.
- Contracts and tests: `apps/backend/tests/**`, `apps/desktop/tests/**`.
- Mac mini runtime remains unchanged for the first vertical slice; execution uses the already-working outbound `chat.completions` relay and current Hermes profiles.

## Non-Goals For This Plan

- Multi-user authentication, workspace ownership, billing, or hosted agents.
- Agent marketplace or arbitrary agent creation.
- Immediate process-level cancellation inside a running Hermes completion. Pause and cancel requests apply at the next persisted checkpoint and are labeled that way.
- External email, publishing, purchasing, trading, or third-party writes.
- Generalizing the personal wiki into a public knowledge product.

## File Map

### Backend files to create

- `apps/backend/app/lib/agent-operations-domain.js`: mission template, autonomy validation, plan parsing, state transitions, session-event redaction, report validation.
- `apps/backend/app/lib/agent-operations-service.js`: use cases for mission creation, planning, task approval, session messaging, report feedback, and task execution.
- `apps/backend/app/lib/agent-operations-api.js`: maps `/api/agent-operations/**` requests to service methods and returns `{ status, body }` responses.
- `apps/backend/app/lib/agent-operations-scheduler.js`: due-task selection, Relay dispatch, task/session/report reconciliation, daemon tick.
- `apps/backend/app/lib/relay-chat-completion.js`: reusable non-streaming Relay completion with event callback.
- `apps/backend/app/db/migrations/0005_agent_operations.sql`: durable mission, session, session-event, and report tables plus task relationship columns.
- `apps/backend/tests/agent-operations.test.cjs`: domain, store restart, Relay planner, API, scheduler, Telegram, and failure contracts.

### Backend files to modify

- `apps/backend/app/lib/store.js`: single-user mission/session/report state and methods; extended Agent Task fields.
- `apps/backend/app/lib/postgres-store.js`: hydrate and persist the new records.
- `apps/backend/app/lib/connectors/telegram.js`: outbound report-summary delivery.
- `apps/backend/app/railway-gateway-server.js`: inject service, route API requests, expose manual tick, start/stop daemon when enabled.
- `apps/backend/package.json`: include new backend modules in syntax check.

### Desktop files to create

- `apps/desktop/src/features/agent-operations/types.ts`: strict mission, task, session, event, report, and envelope types.
- `apps/desktop/src/features/agent-operations/agentOperations.ts`: state labels, calendar appearance, grouping, and API-envelope parsing.
- `apps/desktop/src/features/agent-operations/AgentOperationsScreen.tsx`: Missions, Agents, and Reports workspace tabs.
- `apps/desktop/src/features/agent-operations/TaskSessionPanel.tsx`: Codex-like session list, transcript, contract panel, and intervention controls.
- `apps/desktop/src/features/agent-operations/agent-operations.css`: feature-scoped visual states and responsive layout.
- `apps/desktop/tests/playwright-agent-operations-mission.cjs`: mission creation, plan approval, and calendar rendering.
- `apps/desktop/tests/playwright-agent-task-session.cjs`: transcript, user intervention, pause/resume, reload persistence, and redaction.

### Desktop files to modify

- `apps/desktop/src/api/hermesApi.ts`: typed agent-operation endpoints.
- `apps/desktop/src/App.tsx`: hydrate agent-operation state, mount feature screens, connect calendar items to sessions.
- `apps/desktop/src/styles.css`: only shared calendar-state hooks; all feature layout stays in the new CSS file.

## API Contract

| Method | Path | Outcome |
|---|---|---|
| `GET` | `/api/agent-operations` | Lists missions, agent tasks, sessions, reports, and daemon status. |
| `POST` | `/api/agent-operations/missions` | Creates the Weekly Opportunity Brief mission in `draft`. |
| `POST` | `/api/agent-operations/missions/:id/plan` | Uses `bizconsultant` to generate two to five bounded tasks and one report task. |
| `POST` | `/api/agent-operations/missions/:id/activate` | Activates an approved mission and its initial scheduled work. |
| `POST` | `/api/agent-operations/tasks/:id/:action` | Supports `approve`, `pause`, `resume`, `cancel`, and `retry`. |
| `GET` | `/api/agent-operations/sessions/:id` | Returns one Task Session and ordered redacted events. |
| `POST` | `/api/agent-operations/sessions/:id/messages` | Persists a user instruction and queues or executes a continuation. |
| `POST` | `/api/agent-operations/reports/:id/feedback` | Stores `useful` and optional feedback, then records follow-up decisions. |
| `POST` | `/api/agent-operations/tick` | Runs one deterministic scheduling/reconciliation tick for tests and manual recovery. |

## Task 1: Domain Contracts And Weekly Mission Template

**Files:**
- Create: `apps/backend/app/lib/agent-operations-domain.js`
- Create: `apps/backend/tests/agent-operations.test.cjs`

- [ ] **Step 1: Write failing domain tests**

Add tests with explicit Given/When/Then blocks:

```js
const {
  createWeeklyOpportunityMission,
  parseMissionPlan,
  transitionAgentTask,
  sanitizeSessionEvent,
} = require('../app/lib/agent-operations-domain');

test('creates the personal weekly opportunity mission with bounded autonomy', () => {
  // Given
  const clock = () => new Date('2026-07-13T09:00:00.000Z');

  // When
  const mission = createWeeklyOpportunityMission({ id: 'mission-weekly', clock });

  // Then
  assert.equal(mission.agentId, 'bizconsultant');
  assert.equal(mission.status, 'draft');
  assert.equal(mission.policy.maxRunsPerWeek, 6);
  assert.equal(mission.policy.maxRuntimeMinutesPerWeek, 120);
  assert.deepEqual(mission.policy.forbiddenActions, ['external_message', 'publish', 'purchase', 'trade', 'delete_source']);
});

test('parses a bounded structured plan and rejects duplicate or over-budget work', () => {
  // Given
  const mission = createWeeklyOpportunityMission({ id: 'mission-weekly', clock: () => new Date('2026-07-13T09:00:00.000Z') });
  const raw = JSON.stringify({
    summary: 'Validate three opportunities before the Friday report.',
    tasks: [
      { key: 'scan', title: '경쟁사 변화 수집', reason: '가격 변화 근거가 부족함', expectedOutput: '공식 출처 비교표', scheduledAt: '2026-07-13T10:00:00.000Z', dueAt: '2026-07-13T11:00:00.000Z', estimatedMinutes: 40, actionClass: 'research', sourceRefs: ['web', 'wiki'] },
      { key: 'verify', title: '기회 가설 검증', reason: '수집한 변화를 사업 기회와 연결해야 함', expectedOutput: '근거가 포함된 가설 3개', scheduledAt: '2026-07-15T05:00:00.000Z', dueAt: '2026-07-15T06:00:00.000Z', estimatedMinutes: 40, actionClass: 'analysis', sourceRefs: ['web', 'wiki'] },
      { key: 'report', title: '주간 기회 보고', reason: '금요일 사용자 보고 계약', expectedOutput: '기회 3개와 추천 1개', scheduledAt: '2026-07-17T06:00:00.000Z', dueAt: '2026-07-17T07:00:00.000Z', estimatedMinutes: 40, actionClass: 'report', sourceRefs: ['mission'] },
    ],
  });

  // When
  const plan = parseMissionPlan({ mission, raw });

  // Then
  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.tasks.reduce((sum, task) => sum + task.estimatedMinutes, 0), 120);
  assert.throws(() => parseMissionPlan({ mission, raw: JSON.stringify({ summary: 'bad', tasks: [plan.tasks[0], plan.tasks[0]] }) }), /duplicate/i);
});

test('redacts secrets and private paths from task session events', () => {
  // Given
  const event = { kind: 'tool_activity', text: 'token=secret /Users/koyunseo/private.md', metadata: { authorization: 'Bearer secret' } };

  // When
  const sanitized = sanitizeSessionEvent(event);

  // Then
  assert.doesNotMatch(JSON.stringify(sanitized), /secret|\/Users\/koyunseo/);
  assert.match(sanitized.text, /redacted/i);
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --test apps/backend/tests/agent-operations.test.cjs
```

Expected: FAIL because `agent-operations-domain.js` does not exist.

- [ ] **Step 3: Implement the pure domain module**

Export these exact functions and constants:

```js
const TASK_STATES = ['proposed', 'approved', 'scheduled', 'running', 'blocked', 'completed', 'failed', 'cancelled'];
const SESSION_EVENT_KINDS = ['agent_message', 'user_message', 'plan', 'tool_activity', 'progress', 'approval_request', 'approval_response', 'artifact', 'error', 'completion'];
const ALLOWED_ACTION_CLASSES = ['research', 'analysis', 'report'];

function createWeeklyOpportunityMission({ id, clock = () => new Date() } = {}) {
  if (!id) throw new Error('mission id is required');
  const now = clock().toISOString();
  return {
    id,
    templateId: 'weekly-opportunity-brief',
    title: 'Weekly Opportunity Brief',
    objective: '현재 사업과 제품에 도움이 되는 기회를 근거와 함께 매주 찾는다.',
    successCriteria: ['근거가 있는 기회 3개', '이번 주 추천 행동 1개', '한계와 다음 검증 작업'],
    agentId: 'bizconsultant',
    status: 'draft',
    timezone: 'Asia/Seoul',
    reportSchedule: { weekday: 5, hour: 16, minute: 0 },
    sources: ['wiki', 'web', 'prior_reports'],
    policy: {
      maxRunsPerWeek: 6,
      maxRuntimeMinutesPerWeek: 120,
      firstPlanRequiresApproval: true,
      newActionClassRequiresApproval: true,
      externalSideEffectsRequireApproval: true,
      forbiddenActions: ['external_message', 'publish', 'purchase', 'trade', 'delete_source'],
    },
    budget: { usedRuns: 0, usedMinutes: 0, weekStartedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

function buildMissionPlanPrompt({ mission, priorReports = [], userFeedback = [] } = {}) {
  return JSON.stringify({
    instruction: 'Return JSON only. Create 2-5 bounded tasks, including exactly one report task. Do not perform external side effects.',
    mission,
    priorReports,
    userFeedback,
    schema: {
      summary: 'string',
      tasks: [{ key: 'unique-string', title: 'string', reason: 'string', expectedOutput: 'string', scheduledAt: 'ISO-8601', dueAt: 'ISO-8601', estimatedMinutes: 'positive-number', actionClass: 'research|analysis|report', sourceRefs: ['approved-source'] }],
    },
  });
}

function parseMissionPlan({ mission, raw } = {}) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 2 || parsed.tasks.length > 5) throw new Error('plan must contain 2-5 tasks');
  const keys = new Set();
  let reportCount = 0;
  let minutes = 0;
  const tasks = parsed.tasks.map((task) => {
    const key = String(task.key || '').trim();
    if (!key || keys.has(key)) throw new Error(`duplicate or missing task key: ${key}`);
    keys.add(key);
    if (!ALLOWED_ACTION_CLASSES.includes(task.actionClass)) throw new Error(`action class not allowed: ${task.actionClass}`);
    if (task.actionClass === 'report') reportCount += 1;
    const estimatedMinutes = Number(task.estimatedMinutes);
    if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) throw new Error('estimated minutes must be positive');
    minutes += estimatedMinutes;
    return { ...task, key, estimatedMinutes };
  });
  if (reportCount !== 1) throw new Error('plan must contain exactly one report task');
  if (minutes > mission.policy.maxRuntimeMinutesPerWeek) throw new Error('plan exceeds runtime budget');
  if (tasks.length > mission.policy.maxRunsPerWeek) throw new Error('plan exceeds run budget');
  return { summary: String(parsed.summary || '').trim(), tasks };
}

function transitionAgentTask(task, action, { clock = () => new Date() } = {}) {
  const next = TASK_ACTIONS[action]?.[task.status];
  if (!next) throw new Error(`invalid task transition: ${task.status} -> ${action}`);
  return { ...task, status: next, updatedAt: clock().toISOString() };
}

function sanitizeSessionEvent(event = {}) {
  const redact = (value, key = '') => {
    if (/authorization|token|secret|password|chain.?of.?thought/i.test(key)) return '[redacted]';
    if (typeof value === 'string') return value
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
      .replace(/(?:token|secret|password)\s*[=:]\s*[^\s]+/gi, '[redacted]')
      .replace(/\/(?:Users|home)\/[^\s"']+/g, '[private-path]');
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
    return value;
  };
  return redact(event);
}

function validateReport(report = {}) {
  for (const field of ['findings', 'evidence', 'limitations', 'followUps']) {
    if (!Array.isArray(report[field])) throw new Error(`report ${field} must be an array`);
  }
  if (!report.budget || !Number.isFinite(Number(report.budget.usedMinutes))) throw new Error('report budget is required');
  return report;
}
```

Use an explicit transition map:

```js
const TASK_ACTIONS = {
  approve: { proposed: 'scheduled' },
  pause: { scheduled: 'blocked', running: 'blocked' },
  resume: { blocked: 'scheduled' },
  cancel: { proposed: 'cancelled', scheduled: 'cancelled', blocked: 'cancelled' },
  retry: { failed: 'scheduled' },
  start: { scheduled: 'running' },
  complete: { running: 'completed' },
  fail: { running: 'failed' },
};
```

- [ ] **Step 4: Run domain tests and confirm GREEN**

Run:

```bash
node --test apps/backend/tests/agent-operations.test.cjs
```

Expected: all Task 1 tests PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/backend/app/lib/agent-operations-domain.js apps/backend/tests/agent-operations.test.cjs
git commit -m "feat: define personal agent operation contracts"
```

## Task 2: Durable Mission, Session, Event, Report, And Task Relationships

**Files:**
- Create: `apps/backend/app/db/migrations/0005_agent_operations.sql`
- Modify: `apps/backend/app/lib/store.js`
- Modify: `apps/backend/app/lib/postgres-store.js`
- Modify: `apps/backend/tests/agent-operations.test.cjs`

- [ ] **Step 1: Add a failing restart-persistence test**

```js
test('persists mission task session events and report across a file store restart', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-'));
  const clock = () => new Date('2026-07-13T09:00:00.000Z');
  const first = new HermesStore({ dataDir, clock });
  const mission = first.createAgentMission(createWeeklyOpportunityMission({ id: 'mission-weekly', clock }));
  const task = first.createTask({ title: '경쟁사 변화 수집', owner: 'Agent', status: 'proposed', missionId: mission.id, origin: 'agent', reason: '근거 부족', expectedOutput: '비교표', scheduledAt: '2026-07-13T10:00:00.000Z' });
  const session = first.createAgentSession({ id: 'session-scan', missionId: mission.id, taskId: task.id, status: 'proposed' });
  first.appendAgentSessionEvent(session.id, { kind: 'plan', text: '공식 출처를 먼저 확인한다.' });
  first.createAgentReport({ id: 'report-weekly', missionId: mission.id, status: 'ready', findings: ['기회 1'], evidence: ['source-1'], limitations: [], followUps: [] });

  // When
  const restarted = new HermesStore({ dataDir, clock }).getState();

  // Then
  assert.equal(restarted.agentMissions[0].id, mission.id);
  assert.equal(restarted.tasks.find((item) => item.id === task.id).sessionId, session.id);
  assert.equal(restarted.agentSessionEvents[0].sequence, 1);
  assert.equal(restarted.agentReports[0].id, 'report-weekly');
  await rm(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the persistence test and confirm RED**

Run:

```bash
node --test --test-name-pattern='persists mission task session' apps/backend/tests/agent-operations.test.cjs
```

Expected: FAIL because the new store methods do not exist.

- [ ] **Step 3: Add the migration**

Create `0005_agent_operations.sql` with these tables and indexes:

```sql
create table if not exists agent_missions (
  id text primary key,
  status text not null default 'draft',
  agent_id text not null default '',
  report_due_at text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_sessions (
  id text primary key,
  mission_id text not null references agent_missions(id) on delete cascade,
  task_id text not null default '',
  status text not null default 'proposed',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_session_events (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  sequence integer not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, sequence)
);

create table if not exists agent_reports (
  id text primary key,
  mission_id text not null references agent_missions(id) on delete cascade,
  session_id text not null default '',
  status text not null default 'ready',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tasks add column if not exists mission_id text not null default '';
alter table tasks add column if not exists session_id text not null default '';
create index if not exists tasks_mission_id_idx on tasks(mission_id);
create index if not exists agent_sessions_mission_id_idx on agent_sessions(mission_id);
create index if not exists agent_session_events_session_sequence_idx on agent_session_events(session_id, sequence);
create index if not exists agent_reports_mission_id_idx on agent_reports(mission_id);
```

- [ ] **Step 4: Extend the file store**

Add `agentMissions`, `agentSessions`, `agentSessionEvents`, and `agentReports` arrays to `createDefaultState()` and `#normalizeState()`.

Implement these exact store methods:

```js
createAgentMission(input)
updateAgentMission(missionId, patch)
getAgentMissions()
createAgentSession(input)
updateAgentSession(sessionId, patch)
getAgentSession(sessionId)
appendAgentSessionEvent(sessionId, input)
createAgentReport(input)
updateAgentReport(reportId, patch)
getAgentReports()
```

Extend `createTask()` and `updateTask()` with `missionId`, `sessionId`, `origin`, `createdByAgentId`, `reason`, `expectedOutput`, `scheduledAt`, `dueAt`, `estimatedMinutes`, `actionClass`, `sourceRefs`, `approvalMode`, `pauseRequestedAt`, and `cancelRequestedAt`. Preserve existing task defaults for non-agent tasks.

- [ ] **Step 5: Extend Postgres hydration and persistence**

Hydrate the four new tables in `#hydrateFromPostgres()` and add private upsert/insert methods. `appendAgentSessionEvent()` must insert one event row and use the sequence assigned by the file-store method. Extend `#upsertTask()` to write `mission_id` and `session_id`.

- [ ] **Step 6: Run persistence and full backend tests**

```bash
node --test apps/backend/tests/agent-operations.test.cjs
npm run test:backend
```

Expected: agent-operation persistence tests PASS and the existing backend suite remains green.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/backend/app/db/migrations/0005_agent_operations.sql apps/backend/app/lib/store.js apps/backend/app/lib/postgres-store.js apps/backend/tests/agent-operations.test.cjs
git commit -m "feat: persist agent missions and task sessions"
```

## Task 3: Agent Operations API Without Runtime Execution

**Files:**
- Create: `apps/backend/app/lib/agent-operations-service.js`
- Create: `apps/backend/app/lib/agent-operations-api.js`
- Modify: `apps/backend/app/railway-gateway-server.js`
- Modify: `apps/backend/tests/agent-operations.test.cjs`

- [ ] **Step 1: Write failing API tests for list, create, action, session, and feedback**

Use an isolated `HermesStore` and the existing ephemeral server helper. Assert these exact outcomes:

```js
const createResponse = await fetch(`${baseUrl}/api/agent-operations/missions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'weekly-opportunity-brief' }),
});
const created = await createResponse.json();
assert.equal(createResponse.status, 201);
assert.equal(created.mission.status, 'draft');

const stateResponse = await fetch(`${baseUrl}/api/agent-operations`);
const state = await stateResponse.json();
assert.equal(state.missions.length, 1);

const sessionResponse = await fetch(`${baseUrl}/api/agent-operations/sessions/session-scan`);
assert.equal(sessionResponse.status, 200);

const feedbackResponse = await fetch(`${baseUrl}/api/agent-operations/reports/report-weekly/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ useful: true, note: '의사결정에 사용함' }),
});
assert.equal((await feedbackResponse.json()).report.useful, true);
```

- [ ] **Step 2: Run the API tests and confirm RED**

```bash
node --test --test-name-pattern='agent operations API' apps/backend/tests/agent-operations.test.cjs
```

Expected: FAIL with HTTP 404.

- [ ] **Step 3: Implement service methods with injected dependencies**

Implement `AgentOperationsService` with constructor dependencies `store`, `clock`, `planCompletion`, `taskCompletion`, `sendTelegram`, and later `scheduler`. Its public methods are `listState`, `createMission`, `planMission`, `activateMission`, `transitionTask`, `getSession`, `addSessionMessage`, `recordReportFeedback`, and `tick`.

At this step, use these exact data paths:

- `listState()` returns `{ ok: true, missions: store.getAgentMissions(), tasks: store.getState().tasks.filter(task => task.origin === 'agent'), sessions: store.getState().agentSessions, reports: store.getAgentReports(), daemon: { running: false, lastRun: null } }`.
- `createMission({ templateId })` accepts only `weekly-opportunity-brief`, creates `createWeeklyOpportunityMission({ id: createId('mission'), clock })`, and returns the stored mission.
- `activateMission(missionId)` changes a draft mission to `active` only when it already has at least one task; every `proposed` task stays proposed until explicit approval.
- `transitionTask(taskId, action)` loads the task, applies `transitionAgentTask`, persists it with `store.updateTask`, and appends an `approval_response` event to its existing Task Session.
- `getSession(sessionId)` returns `{ ...session, events }` with events sorted by `sequence`, or throws an error with code `session_not_found`.
- `recordReportFeedback(reportId, { useful, note })` requires a boolean `useful`, stores the feedback and timestamp, and appends it to the linked Mission Thread context.

At this task, `planMission()`, `addSessionMessage()`, and `tick()` return status `503` through the API when their injected runtime dependencies are absent. They must not create fake tasks, messages, or reports.

- [ ] **Step 4: Implement the API router**

Export `routeAgentOperations({ method, pathSegments, body, service })`. Normalize a leading `api` segment, return `null` unless the first normalized segment is `agent-operations`, and map every route in the API Contract table to the corresponding service method. Return `201` for mission creation, `200` for successful reads or commands, `404` for missing mission/task/session/report IDs, `409` for invalid state transitions, `422` for invalid plans or payloads, and `503` for absent Relay/scheduler dependencies. Every handled response body includes `ok`; error bodies also include a stable `error` code and user-safe `message`.

Mount it in `handleApi()` before generic runtime forwarding:

```js
const agentOperationsResponse = await routeAgentOperations({ method, pathSegments, body: requestBody, service: agentOperationsService });
if (agentOperationsResponse) {
  sendJson(res, agentOperationsResponse.status, agentOperationsResponse.body);
  return;
}
```

Extend `createRailwayGatewayServer()` with an optional `agentOperationsService` injection and construct the default service from `gatewayStore`.

- [ ] **Step 5: Run API and release-blocker tests**

```bash
node --test apps/backend/tests/agent-operations.test.cjs
node --test apps/backend/tests/release-blockers.test.cjs
```

Expected: all tests PASS; existing caller and relay authorization contracts remain unchanged.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/backend/app/lib/agent-operations-service.js apps/backend/app/lib/agent-operations-api.js apps/backend/app/railway-gateway-server.js apps/backend/tests/agent-operations.test.cjs
git commit -m "feat: expose personal agent operation APIs"
```

## Task 4: Structured Hermes Planning Through The Existing Outbound Relay

**Files:**
- Create: `apps/backend/app/lib/relay-chat-completion.js`
- Modify: `apps/backend/app/lib/agent-operations-service.js`
- Modify: `apps/backend/app/railway-gateway-server.js`
- Modify: `apps/backend/tests/agent-operations.test.cjs`

- [ ] **Step 1: Write failing Relay planner tests**

Create a fake Relay that yields `delta`, `tool-activity`, and `bridge-complete` events. Assert that:

```js
const completion = await runRelayChatCompletion({
  relay,
  env: { HERMES_RELAY_ENABLED: '1', HERMES_RELAY_TOKEN: 'token' },
  payload: { model: 'bizconsultant', stream: true, messages: [{ role: 'user', content: 'plan' }] },
  meta: { missionId: 'mission-weekly', sessionId: 'session-plan' },
  onEvent: (event) => observed.push(event),
});
assert.match(completion.text, /"tasks"/);
assert.equal(observed.some((event) => event.kind === 'tool_activity'), true);
```

Add an API test where `POST /api/agent-operations/missions/:id/plan` receives valid plan JSON from the fake completion and persists two to five tasks plus one Task Session per task. Add a failure test where malformed JSON returns `422 plan_invalid`, appends an error event to the planning session, and persists zero Agent Tasks.

- [ ] **Step 2: Run planner tests and confirm RED**

```bash
node --test --test-name-pattern='Relay planner|plans a mission' apps/backend/tests/agent-operations.test.cjs
```

Expected: FAIL because `relay-chat-completion.js` does not exist and `planMission()` returns 503.

- [ ] **Step 3: Extract the reusable Relay completion**

Move the non-streaming logic currently owned by `runRailwayRelayChatCompletion()` into the new module as `runRelayChatCompletion({ relay, env, payload, meta, onEvent, timeoutMs })`. It must reject with `runtime_unavailable` before enqueue when Relay is disabled or the bridge is offline, enqueue exactly one `chat.completions` job, poll from cursor `0`, retain every Relay record, convert records to sanitized `tool_activity`, `progress`, `error`, or `agent_message` events before calling `onEvent`, concatenate streamed text in order, and return `{ text, jobId, events }` only when `batch.complete` is true. On bridge `error` or timeout, throw an error carrying both `code` and `jobId`; call `relay.fail()` exactly once on timeout.

Keep the existing schedule assistant and wiki behavior by importing this helper back into `railway-gateway-server.js`.

- [ ] **Step 4: Implement mission planning**

`planMission()` must:

1. create one planning Task Session;
2. append a `plan` event with the mission contract;
3. call `buildMissionPlanPrompt()` with prior reports and useful feedback;
4. call Relay with model/profile `bizconsultant`;
5. append sanitized Relay events as they arrive;
6. parse and validate the final JSON;
7. create each proposed Agent Task and Task Session atomically from the validated result;
8. append `approval_request` events;
9. return `{ mission, plan, tasks, sessions }`.

Do not create tasks when Relay is offline, times out, or returns invalid JSON.

- [ ] **Step 5: Run focused and full backend tests**

```bash
node --test apps/backend/tests/agent-operations.test.cjs
npm run test:backend
npm run backend:check
```

Expected: planner, existing schedule assistant, wiki, relay, and syntax gates PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/backend/app/lib/relay-chat-completion.js apps/backend/app/lib/agent-operations-service.js apps/backend/app/railway-gateway-server.js apps/backend/tests/agent-operations.test.cjs
git commit -m "feat: let Hermes plan bounded mission work"
```

## Task 5: Scheduling, Execution, Session Events, And Report Creation

**Files:**
- Create: `apps/backend/app/lib/agent-operations-scheduler.js`
- Modify: `apps/backend/app/lib/agent-operations-service.js`
- Modify: `apps/backend/app/railway-gateway-server.js`
- Modify: `apps/backend/tests/agent-operations.test.cjs`

- [ ] **Step 1: Write failing scheduler tests with an injected clock**

Cover these deterministic cases:

```js
test('tick executes one due approved task and records ordered session events', async () => {
  // Given: scheduled task at 09:00, clock at 09:01, fake completion emits tool activity and final text.
  // When
  const result = await scheduler.tick();
  // Then
  assert.deepEqual(result.startedTaskIds, ['task-scan']);
  assert.equal(store.getState().tasks.find((task) => task.id === 'task-scan').status, 'completed');
  assert.deepEqual(store.getAgentSession('session-scan').events.map((event) => event.kind), ['plan', 'progress', 'tool_activity', 'agent_message', 'completion']);
});

test('tick marks due work blocked while the relay is offline without creating a fake completion', async () => {
  // Given: completion throws runtime_unavailable.
  // When
  await scheduler.tick();
  // Then
  assert.equal(store.getState().tasks.find((task) => task.id === 'task-scan').status, 'blocked');
  assert.match(store.getAgentSession('session-scan').events.at(-1).text, /offline|unavailable/i);
});
```

Also test idempotency: running the same tick twice cannot execute a completed task twice.

- [ ] **Step 2: Run scheduler tests and confirm RED**

```bash
node --test --test-name-pattern='tick executes|tick marks|idempot' apps/backend/tests/agent-operations.test.cjs
```

Expected: FAIL because `AgentOperationsScheduler` does not exist.

- [ ] **Step 3: Implement the scheduler**

Implement `AgentOperationsScheduler({ store, clock, executeCompletion, sendTelegram })`. `tick()` initializes `{ checkedAt, startedTaskIds: [], completedTaskIds: [], blockedTaskIds: [], createdReportIds: [] }`, selects only `scheduled` tasks whose `scheduledAt <= checkedAt` and whose mission is `active`, processes them in `scheduledAt` then `id` order, and returns those arrays. A task ID is added to `startedTaskIds` only after the persisted reservation succeeds, to `completedTaskIds` only after a non-empty safe completion is persisted, and to `blockedTaskIds` only after the blocked state and error event are persisted. Report IDs are appended after `createAgentReport()` succeeds.

For each due `scheduled` task:

- reserve it by transitioning to `running` before Relay dispatch;
- append a progress event;
- build messages from mission contract, task contract, prior session user messages, and approved source references;
- pass Relay events through `sanitizeSessionEvent()`;
- transition to `completed` only after non-empty assistant output;
- transition to `blocked` for runtime unavailability and `failed` for malformed/unsafe output;
- persist an artifact event containing assistant text and evidence metadata;
- when `actionClass === 'report'`, parse `validateReport()` JSON and create an Agent Report;
- use `task.id` as the idempotency key in Relay meta.

- [ ] **Step 4: Wire manual and automatic ticks**

`POST /api/agent-operations/tick` calls the same scheduler instance.

Use the existing `SchedulerDaemon` with `AGENT_OPERATIONS_DAEMON_ENABLED=true` and `AGENT_OPERATIONS_TICK_MS=60000`. Start it only after the Postgres store is ready and stop it on server close. Tests leave the env variable unset so they never start timers.

- [ ] **Step 5: Run scheduler, release-blocker, and full backend tests**

```bash
node --test apps/backend/tests/agent-operations.test.cjs
node --test apps/backend/tests/release-blockers.test.cjs
npm run test:backend
```

Expected: all tests PASS, including the existing orphaned-run restart contract.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/backend/app/lib/agent-operations-scheduler.js apps/backend/app/lib/agent-operations-service.js apps/backend/app/railway-gateway-server.js apps/backend/tests/agent-operations.test.cjs
git commit -m "feat: schedule and report autonomous agent work"
```

## Task 6: Codex-Like Task Session Interventions

**Files:**
- Modify: `apps/backend/app/lib/agent-operations-service.js`
- Modify: `apps/backend/app/lib/agent-operations-api.js`
- Modify: `apps/backend/tests/agent-operations.test.cjs`

- [ ] **Step 1: Write failing session-intervention tests**

Cover one idle continuation and one in-flight instruction:

```js
const messageResponse = await fetch(`${baseUrl}/api/agent-operations/sessions/session-scan/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'B사의 중소팀 요금 변화에 집중해줘.' }),
});
const messageBody = await messageResponse.json();
assert.equal(messageBody.event.kind, 'user_message');
assert.equal(messageBody.session.pendingInstructions.length, 1);

const pauseResponse = await fetch(`${baseUrl}/api/agent-operations/tasks/task-scan/pause`, { method: 'POST' });
const paused = await pauseResponse.json();
assert.equal(paused.task.status, 'blocked');
assert.equal(paused.task.pauseMode, 'next_checkpoint');
```

Assert that reload returns the user message, queued instruction, and pause event in the same sequence order. Assert that retry from `failed` creates a new run attempt in the existing Task Session rather than a new session.

- [ ] **Step 2: Run session tests and confirm RED**

```bash
node --test --test-name-pattern='session intervention|pause request|retry' apps/backend/tests/agent-operations.test.cjs
```

Expected: FAIL because message and action semantics are not implemented.

- [ ] **Step 3: Implement truthful intervention semantics**

- A message on `proposed`, `scheduled`, `blocked`, `completed`, or `failed` appends `user_message` and `pendingInstructions`.
- A message while `running` is labeled `applies_at_next_checkpoint`; it must not claim to alter the already-running process.
- `pause` and `cancel` during `running` set `pauseRequestedAt` or `cancelRequestedAt`; the scheduler applies them before any next completion or retry.
- `resume` moves `blocked` work to `scheduled` and appends `approval_response`.
- `retry` keeps the same session, clears the terminal error, increments `attempt`, and schedules a new completion.
- A continuation completion includes the Mission Thread summary, prior user messages, latest assistant result, and pending instructions without including hidden chain-of-thought.

- [ ] **Step 4: Run session and full backend tests**

```bash
node --test apps/backend/tests/agent-operations.test.cjs
npm run test:backend
```

Expected: all session events are ordered, persisted, redacted, and honest about checkpoint timing.

- [ ] **Step 5: Commit Task 6**

```bash
git add apps/backend/app/lib/agent-operations-service.js apps/backend/app/lib/agent-operations-api.js apps/backend/tests/agent-operations.test.cjs
git commit -m "feat: support persistent agent task conversations"
```

## Task 7: Telegram Report Summary Delivery

**Files:**
- Modify: `apps/backend/app/lib/connectors/telegram.js`
- Modify: `apps/backend/app/lib/agent-operations-scheduler.js`
- Modify: `apps/backend/tests/agent-operations.test.cjs`

- [ ] **Step 1: Write failing Telegram delivery tests**

```js
test('sends a minimized report summary to the configured personal Telegram chat', async () => {
  // Given
  const calls = [];
  const report = { id: 'report-weekly', title: '주간 기회 보고', findings: ['기회 A', '기회 B', '기회 C'], evidence: ['source-1'], limitations: ['가격 검증 필요'] };

  // When
  await sendTelegramMessage({ botToken: 'bot-token', chatId: '1234', text: formatAgentReportTelegram(report, { appUrl: 'agent-calendar://reports/report-weekly' }), fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } });

  // Then
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.chat_id, '1234');
  assert.match(sent.text, /주간 기회 보고/);
  assert.doesNotMatch(sent.text, /\/Users\/|Bearer|embedding/i);
});
```

Add failure coverage: Telegram HTTP 500 records `deliveryStatus: failed` and a session error event but does not change a completed report to failed.

- [ ] **Step 2: Run Telegram tests and confirm RED**

```bash
node --test --test-name-pattern='Telegram' apps/backend/tests/agent-operations.test.cjs
```

Expected: FAIL because `sendTelegramMessage()` is not exported.

- [ ] **Step 3: Implement outbound delivery**

Export `sendTelegramMessage({ botToken, chatId, text, fetchImpl = fetch })` and `formatAgentReportTelegram(report, { appUrl = '' })`. The sender validates non-empty credentials and text, posts JSON to `https://api.telegram.org/bot${botToken}/sendMessage`, throws `telegram_delivery_failed` for a non-2xx response or `{ ok: false }`, and returns the Telegram `result`. The formatter includes the report title, at most three findings, at most one limitation, and the app deep link; it never includes the evidence bundle, filesystem paths, model credentials, or Relay metadata.

Use Telegram `sendMessage`, `disable_web_page_preview: true`, and plain text. Select the first configured allowed chat ID for this personal phase. Store only delivery status, Telegram message ID, and sent timestamp on the Agent Report.

- [ ] **Step 4: Run focused and backend tests**

```bash
node --test apps/backend/tests/agent-operations.test.cjs
npm run test:backend
```

Expected: success and failure paths PASS without exposing full private evidence.

- [ ] **Step 5: Commit Task 7**

```bash
git add apps/backend/app/lib/connectors/telegram.js apps/backend/app/lib/agent-operations-scheduler.js apps/backend/tests/agent-operations.test.cjs
git commit -m "feat: deliver agent reports to Telegram"
```

## Task 8: Typed Desktop Contracts And Hydration

**Files:**
- Create: `apps/desktop/src/features/agent-operations/types.ts`
- Create: `apps/desktop/src/features/agent-operations/agentOperations.ts`
- Modify: `apps/desktop/src/api/hermesApi.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/tests/playwright-agent-operations-mission.cjs`

- [ ] **Step 1: Write the failing Playwright hydration contract**

Mock `GET /api/agent-operations` with one mission, three agent tasks, sessions, and one report. Navigate to Agents and assert that the page exposes `Missions`, `Agents`, and `Reports` tabs and that the calendar request data does not disappear after hydration.

The mock envelope is:

```js
{
  ok: true,
  missions: [{ id: 'mission-weekly', title: 'Weekly Opportunity Brief', status: 'active', agentId: 'bizconsultant', budget: { usedMinutes: 42, maxMinutes: 120 } }],
  tasks: [{ id: 'task-scan', missionId: 'mission-weekly', sessionId: 'session-scan', title: '경쟁사 변화 수집', status: 'running', scheduledAt: '2026-07-13T09:00:00.000Z', dueAt: '2026-07-13T11:30:00.000Z', agent: 'bizconsultant', origin: 'agent', reason: '근거 부족', expectedOutput: '비교표' }],
  sessions: [{ id: 'session-scan', missionId: 'mission-weekly', taskId: 'task-scan', status: 'running' }],
  reports: [],
  daemon: { running: true, lastRun: null },
}
```

- [ ] **Step 2: Run Playwright and confirm RED**

```bash
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-operations-mission.cjs
```

Expected: FAIL because the API is not requested and the tabs do not exist.

- [ ] **Step 3: Add strict frontend types and parsers**

Define discriminated unions for mission, task, and event states. The exported types include:

```ts
export type AgentTaskState = 'proposed' | 'approved' | 'scheduled' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type SessionEventKind = 'agent_message' | 'user_message' | 'plan' | 'tool_activity' | 'progress' | 'approval_request' | 'approval_response' | 'artifact' | 'error' | 'completion';
export type AgentOperationsState = Readonly<{ missions: readonly AgentMission[]; tasks: readonly AgentTask[]; sessions: readonly AgentSession[]; reports: readonly AgentReport[]; daemon: AgentOperationsDaemon }>;
```

`parseAgentOperationsEnvelope()` must validate arrays and normalize unknown response values without `any`, `as any`, `@ts-ignore`, or `@ts-expect-error`.

- [ ] **Step 4: Add API methods and hydrate state**

Add `getAgentOperations`, `createAgentMission`, `planAgentMission`, `activateAgentMission`, `transitionAgentTask`, `getAgentSession`, `sendAgentSessionMessage`, `recordAgentReportFeedback`, and `tickAgentOperations` to `hermesApi`.

Load `GET /api/agent-operations` as a non-critical hydration source so unrelated calendar/wiki screens remain usable if agent operations fail. Store its error separately and show it only inside the Agent workspace.

- [ ] **Step 5: Run typecheck and the failing Playwright script**

```bash
npm run typecheck
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-operations-mission.cjs
```

Expected: typecheck PASS; Playwright progresses to the still-unimplemented view assertion.

- [ ] **Step 6: Commit Task 8**

```bash
git add apps/desktop/src/features/agent-operations/types.ts apps/desktop/src/features/agent-operations/agentOperations.ts apps/desktop/src/api/hermesApi.ts apps/desktop/src/App.tsx apps/desktop/tests/playwright-agent-operations-mission.cjs
git commit -m "feat: hydrate personal agent operation state"
```

## Task 9: Mission, Agent, And Report Workspace

**Files:**
- Create: `apps/desktop/src/features/agent-operations/AgentOperationsScreen.tsx`
- Create: `apps/desktop/src/features/agent-operations/agent-operations.css`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/tests/playwright-agent-operations-mission.cjs`

- [ ] **Step 1: Extend Playwright with the full mission workflow**

Assert this sequence:

1. Open Agents.
2. Open Missions tab.
3. Create Weekly Opportunity Brief.
4. Review objective, budget, Friday report cadence, allowed sources, and forbidden actions.
5. Click `계획 만들기`.
6. See three proposed tasks with reasons and expected outputs.
7. Approve the plan.
8. See the mission status become active.
9. Open Reports and see the empty first-week state without a fake report.

- [ ] **Step 2: Run Playwright and confirm RED**

```bash
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-operations-mission.cjs
```

Expected: FAIL at the missing Missions UI.

- [ ] **Step 3: Build the feature screen**

`AgentOperationsScreen` receives only typed data and command callbacks:

```tsx
type AgentOperationsScreenProps = Readonly<{
  state: AgentOperationsState;
  agents: readonly Item[];
  activeTab: 'missions' | 'agents' | 'reports';
  onTabChange: (tab: 'missions' | 'agents' | 'reports') => void;
  onCreateMission: () => Promise<void>;
  onPlanMission: (missionId: string) => Promise<void>;
  onActivateMission: (missionId: string) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
  onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
}>;
```

Keep cards at 8px radius or less, use tabs for views, icon buttons for pause/stop where appropriate, and show budget as a progress bar with exact values. Replace the current free-form mission launcher with the template and contract flow, but keep the current agent roster inside the Agents tab.

- [ ] **Step 4: Add feature CSS and mount the screen**

Import `agent-operations.css` from `App.tsx`. Do not add the feature layout to the already-large global stylesheet. Maintain the existing compact desktop shell and responsive narrow layout.

- [ ] **Step 5: Run Playwright, typecheck, and desktop tests**

```bash
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-operations-mission.cjs
npm run typecheck
npm --workspace apps/desktop run test
```

Expected: mission workflow PASS; existing desktop contract tests remain green.

- [ ] **Step 6: Commit Task 9**

```bash
git add apps/desktop/src/features/agent-operations/AgentOperationsScreen.tsx apps/desktop/src/features/agent-operations/agent-operations.css apps/desktop/src/App.tsx apps/desktop/tests/playwright-agent-operations-mission.cjs
git commit -m "feat: add mission and report workspace"
```

## Task 10: Calendar Visualization And Task Session UI

**Files:**
- Create: `apps/desktop/src/features/agent-operations/TaskSessionPanel.tsx`
- Modify: `apps/desktop/src/features/agent-operations/agentOperations.ts`
- Modify: `apps/desktop/src/features/agent-operations/agent-operations.css`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/tests/playwright-agent-task-session.cjs`
- Modify: `apps/desktop/tests/playwright-agent-operations-mission.cjs`

- [ ] **Step 1: Write failing calendar and session Playwright scenarios**

Calendar assertions:

- proposed task uses amber dashed style and includes `에이전트 제안`;
- scheduled/running task uses blue state and agent name;
- completed report uses green state;
- blocked task uses red state with a reason;
- `Me`, `Agents`, and `Combined` filters preserve stable calendar geometry.

Session assertions:

- clicking a calendar Agent Task opens its Task Session;
- the left list shows sibling sessions under the mission;
- the transcript orders `plan`, `tool_activity`, `user_message`, `agent_message`, and `completion` by sequence;
- the right panel shows expected output, time, budget, sources, artifacts, and state;
- sending a message persists after reload;
- pause/resume labels `next checkpoint` while work is running;
- secrets and `/Users/...` paths never appear.

- [ ] **Step 2: Run both scripts and confirm RED**

```bash
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-operations-mission.cjs
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-task-session.cjs
```

Expected: FAIL on missing state styles and Task Session panel.

- [ ] **Step 3: Map agent states to calendar appearance**

Export an exhaustive function:

```ts
export function agentTaskAppearance(state: AgentTaskState): Readonly<{ label: string; tone: 'amber' | 'blue' | 'green' | 'red' | 'neutral'; line: 'dashed' | 'solid' }> {
  switch (state) {
    case 'proposed': return { label: '에이전트 제안', tone: 'amber', line: 'dashed' };
    case 'approved':
    case 'scheduled': return { label: '예약됨', tone: 'blue', line: 'solid' };
    case 'running': return { label: '실행 중', tone: 'blue', line: 'solid' };
    case 'completed': return { label: '보고 완료', tone: 'green', line: 'solid' };
    case 'blocked':
    case 'failed': return { label: state === 'blocked' ? '차단됨' : '실패', tone: 'red', line: 'solid' };
    case 'cancelled': return { label: '취소됨', tone: 'neutral', line: 'solid' };
  }
}
```

Merge Agent Tasks into the existing calendar item list without converting them to ordinary user tasks. `openTask()` must route records with `sessionId` to `openAgentSession()`.

- [ ] **Step 4: Build the Task Session panel**

The component contract is:

```tsx
type TaskSessionPanelProps = Readonly<{
  mission: AgentMission;
  task: AgentTask;
  session: AgentSessionDetail;
  siblingSessions: readonly AgentSession[];
  onSelectSession: (sessionId: string) => void;
  onSendMessage: (text: string) => Promise<void>;
  onAction: (action: 'approve' | 'pause' | 'resume' | 'cancel' | 'retry') => Promise<void>;
  onClose: () => void;
}>;
```

Use the three-column desktop layout from the approved visual design, collapse to session list → transcript → details on narrow screens, and keep the input/control row fixed without covering transcript content.

- [ ] **Step 5: Run UI gates and visual QA**

```bash
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-operations-mission.cjs
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-task-session.cjs
npm run typecheck
npm run build:desktop
```

Then use the `omo:visual-qa` skill to capture desktop and narrow screenshots under `apps/desktop/audit/agent-operations-2026-07-13/`. Verify no overlap, blank panels, hidden transcript rows, clipped buttons, or state-induced layout shifts.

- [ ] **Step 6: Commit Task 10**

```bash
git add apps/desktop/src/features/agent-operations/TaskSessionPanel.tsx apps/desktop/src/features/agent-operations/agentOperations.ts apps/desktop/src/features/agent-operations/agent-operations.css apps/desktop/src/App.tsx apps/desktop/tests/playwright-agent-operations-mission.cjs apps/desktop/tests/playwright-agent-task-session.cjs apps/desktop/audit/agent-operations-2026-07-13
git commit -m "feat: visualize agent work and task sessions"
```

## Task 11: Full Contract Verification, Railway Migration, And Personal Live Run

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `docs/superpowers/plans/2026-07-13-personal-agent-operations-calendar.md` checklist and evidence section only
- Evidence: `apps/desktop/audit/agent-operations-2026-07-13/**`

- [ ] **Step 1: Expand backend syntax checks**

Update the backend `check` script to include:

```json
"check": "node -c app/railway-gateway-server.js && node -c app/db/migrate.js && node -c app/lib/schedule-assistant.js && node -c app/lib/agent-operations-domain.js && node -c app/lib/agent-operations-service.js && node -c app/lib/agent-operations-api.js && node -c app/lib/agent-operations-scheduler.js && node -c app/lib/relay-chat-completion.js"
```

- [ ] **Step 2: Run all local verification gates**

```bash
npm run backend:check
npm run test:backend
npm run typecheck
npm --workspace apps/desktop run test
npm run build:desktop
npm test
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-operations-mission.cjs
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-task-session.cjs
HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-mission.cjs
```

Expected: every command exits 0.

- [ ] **Step 3: Run migration against Railway Postgres**

```bash
npm run backend:migrate
```

Expected JSON contains `0005_agent_operations.sql` in `migrations`.

- [ ] **Step 4: Deploy the Railway gateway**

```bash
railway up --detach
railway status
```

Expected: deployment is online. Set `AGENT_OPERATIONS_DAEMON_ENABLED=true` and `AGENT_OPERATIONS_TICK_MS=60000` in the Railway service before the live scheduling check.

- [ ] **Step 5: Execute the real personal harmless flow**

Through the desktop UI at `http://127.0.0.1:5586/`:

1. Create `Weekly Opportunity Brief · QA`.
2. Generate the first plan through `bizconsultant` on the real Mac mini relay.
3. Confirm two to five bounded tasks and one report task appear as proposed calendar work.
4. Approve one short harmless research task whose expected output is a one-paragraph report of the selected profile name and runtime availability.
5. Trigger one manual tick.
6. Open its Task Session and observe actual Relay events, non-empty assistant output, and `completion`.
7. Send one follow-up message and confirm it remains after reload.
8. Create a report record and verify the Telegram summary reaches the configured personal chat.

Do not delete the QA mission or its records. Pause it after verification so the full audit trail remains visible without scheduling further work.

- [ ] **Step 6: Verify one real failure path**

Pause the mission before another task becomes due and run a manual tick. Verify no execution starts. Use a test-injected offline response for UI evidence rather than shutting down the real Mac mini, and verify the Task Session shows `blocked`, the cause, and a retry action without false completion.

- [ ] **Step 7: Run the required post-implementation review**

Use `omo:review-work` and `omo:debugging`. Record three runtime hypotheses and evidence in the plan's evidence section:

1. a due approved task might execute twice;
2. session events might reorder or disappear after reload;
3. a Relay or Telegram failure might falsely fail a completed report.

Each hypothesis must be confirmed or rejected with runtime/API evidence.

- [ ] **Step 8: Commit Task 11**

```bash
git add apps/backend/package.json docs/superpowers/plans/2026-07-13-personal-agent-operations-calendar.md apps/desktop/audit/agent-operations-2026-07-13
git commit -m "test: verify personal agent operations end to end"
```

## Final Completion Criteria

- The approved design's 14 acceptance gates are each mapped to a passing automated or live check.
- The Weekly Opportunity Brief mission creates bounded work through the real `bizconsultant` profile.
- Agent work is visible on the calendar and opens a persistent Task Session.
- Session messages, checkpoint actions, artifacts, failures, and reports survive reload.
- Telegram receives only the minimized report summary and session link.
- The Mac mini or Relay being unavailable never creates fake work or completion.
- The full backend, desktop, build, and Playwright gates pass.
- The worktree contains no unrelated changes and no uncommitted product changes.
