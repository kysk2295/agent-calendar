const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const evidenceDir = process.env.EVIDENCE_DIR || path.resolve('.omo/evidence/agent-work-operating-system/task-5-workspace');
const createdAt = '2026-07-14T09:00:00.000Z';
const mission = {
  id: 'work-existing', templateId: 'general-agent-work', title: '검증용 운영 작업', objective: '근거를 검토하고 실행을 제어한다.',
  successCriteria: ['검토 완료'], agentId: 'bizconsultant', executionEngine: 'auto', deliverable: { kind: 'report', format: 'markdown' },
  status: 'active', timezone: 'Asia/Seoul', sources: ['web'], reportSchedule: { weekday: 5, hour: 16, minute: 0 },
  policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: [] },
  budget: { usedRuns: 1, usedMinutes: 20, weekStartedAt: createdAt }, missionThreadId: 'thread-existing',
  planSummary: '근거를 검토합니다.', plannedAt: createdAt, createdAt, updatedAt: createdAt,
};
const task = {
  id: 'task-existing', missionId: mission.id, sessionId: 'session-existing', title: '근거 검토', status: 'running',
  agent: mission.agentId, origin: 'agent', reason: '공식 근거가 필요합니다.', expectedOutput: '검토 보고서', scheduledAt: createdAt,
  dueAt: createdAt, date: '2026-07-14', time: '18:00', estimatedMinutes: 20, actionClass: 'research', sourceRefs: ['web'],
  executionEngine: 'auto', deliverable: mission.deliverable, blockedReason: '', pauseMode: '', attempt: 1, reportId: 'report-new',
};
const reports = [{
  id: 'report-old', missionId: mission.id, sessionId: task.sessionId, taskId: task.id, title: '이전 검토 결과', status: 'ready',
  findings: ['과거 결과'], evidence: [{ label: '안전한 근거', url: 'https://example.com/safe' }], limitations: [], followUps: [],
  followUpDecisions: [], budget: { usedRuns: 1, usedMinutes: 10 }, deliveryStatus: 'ready', useful: null,
  createdAt: '2026-07-14T08:00:00.000Z', updatedAt: '2026-07-14T08:00:00.000Z',
}, {
  id: 'report-new', missionId: mission.id, sessionId: task.sessionId, taskId: task.id, title: '현재 검토 결과', status: 'ready',
  findings: ['현재 결과'], evidence: [
    { label: '스크립트 링크', url: 'javascript:alert(1)' }, { label: '데이터 링크', url: 'data:text/html,bad' },
    { label: '파일 링크', url: 'file:///tmp/private' }, { label: '빈 링크', url: '' }, { label: '잘못된 링크', url: 'not a url' },
  ], limitations: [], followUps: [], followUpDecisions: [], budget: { usedRuns: 1, usedMinutes: 20 }, deliveryStatus: 'ready', useful: null,
  createdAt, updatedAt: createdAt,
}];
let operationState = { ok: true, missions: [mission], tasks: [task], sessions: [], reports, daemon: { running: true, lastRun: createdAt, lastError: null } };

function work(missionValue, currentResultReportId) {
  return {
    id: missionValue.id, templateId: missionValue.templateId, title: missionValue.title, objective: missionValue.objective,
    status: missionValue.status, agentId: missionValue.agentId, assignmentReason: `explicit:${missionValue.agentId}`,
    executionEngine: missionValue.executionEngine, deliverable: missionValue.deliverable, missionThreadId: missionValue.missionThreadId,
    workConversationId: missionValue.missionThreadId, revisionCounter: 1, pendingRevisionId: '', currentResultReportId,
    createdAt: missionValue.createdAt, updatedAt: missionValue.updatedAt,
  };
}

function conversationPayload(missionValue, currentResultReportId) {
  return { ok: true, work: work(missionValue, currentResultReportId), conversation: {
    id: missionValue.missionThreadId, missionId: missionValue.id, taskId: '', type: 'mission-thread', title: missionValue.title,
    status: 'waiting_for_approval', pendingInstructions: [], executionEngine: missionValue.executionEngine,
    deliverable: missionValue.deliverable, createdAt: missionValue.createdAt, updatedAt: missionValue.updatedAt,
  }, checkpoints: [{ id: `initial-${missionValue.id}`, sessionId: missionValue.missionThreadId, sequence: 1, kind: 'user_message', text: missionValue.objective, metadata: {}, createdAt: missionValue.createdAt }, ...(missionValue.id === mission.id ? [
    { id: 'result-old', sessionId: task.sessionId, sequence: 2, kind: 'completion', text: '이전 검토 결과', metadata: { reportId: 'report-old', taskId: task.id }, createdAt: reports[0].createdAt },
    { id: 'result-new', sessionId: task.sessionId, sequence: 3, kind: 'completion', text: '현재 검토 결과', metadata: { reportId: 'report-new', taskId: task.id }, createdAt: reports[1].createdAt },
  ] : [])], nextCursor: null };
}

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve('apps/desktop'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function main() {
  const { server, url } = await startVite();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const failures = [];
  let aggregateRefreshFailuresRemaining = 0;
  const check = async (name, action) => {
    try { await action(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); process.stdout.write(`RED ${name}\n`); }
  };

  await page.route('**/*', async (route) => {
    const request = route.request();
    const apiPath = new URL(request.url()).pathname;
    if (!apiPath.startsWith('/api/')) { await route.continue(); return; }
    if (request.method() === 'GET' && apiPath === '/api/agent-operations') {
      if (aggregateRefreshFailuresRemaining > 0) { aggregateRefreshFailuresRemaining -= 1; await route.fulfill({ status: 503, json: { ok: false, error: 'refresh unavailable' } }); return; }
      await route.fulfill({ json: operationState }); return;
    }
    if (request.method() === 'GET' && apiPath === '/api/agents') { await route.fulfill({ json: { ok: true, agents: [{ id: mission.agentId, displayName: 'Business Consultant', status: 'ready', model: 'Recommended', role: '검토', provider: 'Hermes', trustLevel: '승인', allowedTaskClasses: ['research'] }] } }); return; }
    if (request.method() === 'GET' && apiPath === `/api/agent-operations/work/${mission.id}/conversation`) { await route.fulfill({ json: conversationPayload(mission, 'report-new') }); return; }
    if (request.method() === 'POST' && apiPath === `/api/agent-operations/work/${mission.id}/messages`) {
      const body = request.postDataJSON();
      if (body.text === '이제 실패') { await route.fulfill({ status: 503, json: { ok: false, error: 'temporary_failure', message: '잠시 후 다시 시도하세요.' } }); return; }
      const nextCheckpoint = body.text === '다음 체크포인트에 멈춰줘';
      await route.fulfill({ json: { ok: true, message: { id: `message-${body.text}`, sessionId: mission.missionThreadId, sequence: 2, kind: 'user_message', text: body.text, metadata: {}, createdAt }, delivery: { status: 'accepted', applicationMode: nextCheckpoint ? 'next_checkpoint' : 'mission_context', acceptedAt: createdAt }, idempotentReplay: false } }); return;
    }
    if (request.method() === 'POST' && apiPath === '/api/agent-operations/work') {
      const body = request.postDataJSON();
      const createdMission = { ...mission, id: 'work-created', title: body.title, objective: body.objective, status: 'draft', missionThreadId: 'thread-created' };
      aggregateRefreshFailuresRemaining = 2;
      await route.fulfill({ status: 201, json: { ...conversationPayload(createdMission, ''), message: { id: 'initial-created', sessionId: createdMission.missionThreadId, sequence: 1, kind: 'user_message', text: body.initialMessage, metadata: {}, createdAt }, idempotentReplay: false } }); return;
    }
    if (request.method() === 'GET' && apiPath === '/api/agent-operations/work/work-created/conversation') {
      const createdMission = { ...mission, id: 'work-created', title: 'aggregate 누락 작업', objective: 'aggregate 누락 작업', status: 'draft', missionThreadId: 'thread-created' };
      await route.fulfill({ json: conversationPayload(createdMission, '') }); return;
    }
    await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], notes: [], graph: { nodes: [], edges: [] }, items: [], commands: [], jobs: [], messages: [], channels: [], tools: [], settings: { uiPreferences: {} }, uiPreferences: {} } });
  });

  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.goto(url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await page.locator('.agent-running-card', { hasText: task.title }).click();
    await page.locator('.agent-work-conversation').waitFor();
    await page.locator('.agent-checkpoint-result', { hasText: '현재 검토 결과' }).waitFor();
    await check('revision-current-result', async () => {
      assert.equal(await page.locator('.agent-checkpoint-result', { hasText: /^현재 결과/ }).count(), 1);
      assert.match(await page.locator('.agent-checkpoint-result', { hasText: '현재 검토 결과' }).textContent() || '', /현재 결과/);
      assert.match(await page.locator('.agent-checkpoint-result', { hasText: '이전 검토 결과' }).textContent() || '', /이전 결과/);
    });
    await check('safe-evidence-links', async () => {
      assert.equal(await page.locator('.agent-work-evidence a').count(), 1);
      assert.equal(await page.locator('.agent-work-evidence a').first().getAttribute('href'), 'https://example.com/safe');
      assert.equal(await page.locator('.agent-work-evidence').getByText('스크립트 링크').getAttribute('href'), null);
      assert.match(await page.locator('.agent-work-evidence').getByText(/차단됨.*스크립트 링크/).textContent() || '', /차단됨/);
    });
    const composer = page.getByLabel('작업 대화 메시지');
    await check('next-checkpoint-copy', async () => {
      await composer.fill('다음 체크포인트에 멈춰줘');
      await page.getByRole('button', { name: '작업 대화에 보내기' }).click();
      const copy = await page.locator('.agent-work-delivery').textContent() || '';
      assert.match(copy, /다음 체크포인트.*요청|다음 체크포인트.*반영/);
      assert.doesNotMatch(copy, /저장되었습니다/);
      await page.screenshot({ path: path.join(evidenceDir, 'verifier-next-checkpoint-desktop.png'), fullPage: true });
    });
    await check('failure-clears-stale-success', async () => {
      await composer.fill('이제 실패');
      await page.getByRole('button', { name: '작업 대화에 보내기' }).click();
      await page.locator('.agent-work-message-error').waitFor();
      assert.equal(await page.locator('.agent-work-delivery').count(), 0);
      assert.equal(await composer.inputValue(), '이제 실패');
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: path.join(evidenceDir, 'verifier-two-results-unsafe-failure-desktop.png') });
    });
    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    await check('create-survives-aggregate-refresh-failure', async () => {
      const prompt = page.getByLabel('에이전트에게 작업 지시');
      await prompt.fill('aggregate 누락 작업');
      await page.getByRole('button', { name: '위임' }).click();
      await page.locator('.agent-work-conversation').waitFor({ timeout: 2000 });
      assert.match(await page.locator('.agent-work-header').textContent() || '', /aggregate 누락 작업/);
      assert.equal(await page.locator('.agent-control-room-board').count(), 0);
      const createdComposer = page.getByLabel('작업 대화 메시지');
      assert.equal(await createdComposer.isEnabled(), true);
      await createdComposer.fill('새로고침 중에도 보존할 후속 지시');
      const aggregateError = page.locator('.agent-operations-error');
      await aggregateError.waitFor();
      assert.match(await aggregateError.textContent() || '', /최신 작업 상태를 새로고침하지 못했습니다/);
      assert.doesNotMatch(await aggregateError.textContent() || '', /\/api\/|503|refresh unavailable/i);
      assert.equal(await aggregateError.getByRole('button', { name: '다시 시도' }).count(), 1);
      assert.equal(await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).count(), 1);
      assert.equal(await createdComposer.inputValue(), '새로고침 중에도 보존할 후속 지시');
      for (const viewport of [{ width: 1280, height: 900, name: 'desktop' }, { width: 768, height: 900, name: 'tablet' }, { width: 375, height: 812, name: 'mobile' }]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.locator('.agent-work-details').count(), 0, `${viewport.name}: stale details must be hidden`);
        assert.equal(await page.getByRole('button', { name: /^(계획 만들기|전체 승인|작업 중단|전체 일시정지|이 제안 승인|이 제안 거절)$/ }).count(), 0, `${viewport.name}: stale aggregate actions must be hidden`);
        assert.equal(await createdComposer.isEnabled(), true, `${viewport.name}: direct conversation messages remain safe`);
        const aggregateErrorText = aggregateError.locator('span');
        assert.equal(await aggregateErrorText.evaluate((element) => getComputedStyle(element).wordBreak), 'keep-all');
        if (viewport.name === 'mobile') {
          const splitPredicate = await aggregateErrorText.evaluate((element) => {
            const target = '못했습니다';
            const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes(target));
            if (!textNode?.textContent) throw new Error('aggregate error text missing');
            const start = textNode.textContent.indexOf(target);
            const range = document.createRange();
            range.setStart(textNode, start);
            range.setEnd(textNode, start + target.length);
            return range.getClientRects().length > 1;
          });
          assert.equal(splitPredicate, false, '못했습니다 must remain on one line');
        }
        await page.screenshot({ path: path.join(evidenceDir, `${viewport.name}-aggregate-error.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      const aggregateRetry = aggregateError.getByRole('button', { name: '다시 시도' });
      await aggregateRetry.click();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await aggregateError.isVisible(), true);
      assert.equal(await aggregateRetry.evaluate((element) => element === document.activeElement), true);
      assert.equal(await page.locator('.agent-work-details').count(), 0);
      assert.equal(await createdComposer.inputValue(), '새로고침 중에도 보존할 후속 지시');
      await aggregateRetry.click();
      await aggregateError.waitFor({ state: 'detached' });
      assert.match(await page.locator('.agent-work-header').textContent() || '', /aggregate 누락 작업/);
      assert.equal(await createdComposer.inputValue(), '새로고침 중에도 보존할 후속 지시');
      assert.equal(await page.locator('.agent-work-header h1').evaluate((element) => element === document.activeElement), true);
      assert.equal(await page.locator('.agent-work-scrim, .agent-work-drawer').count(), 0);
      assert.equal(await page.locator('.agent-work-details').count(), 1);
      assert.equal(await page.getByRole('button', { name: '계획 만들기', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: '작업 중단', exact: true }).count(), 1);
      for (const viewport of [{ width: 1280, height: 900, name: 'desktop' }, { width: 768, height: 900, name: 'tablet' }, { width: 375, height: 812, name: 'mobile' }]) {
        await page.setViewportSize(viewport);
        const metrics = await page.locator('.agent-work-conversation').evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
        assert.equal(metrics.scrollWidth <= metrics.clientWidth, true);
        const box = await page.locator('.agent-work-composer').boundingBox();
        assert.equal(Boolean(box && box.y >= 0 && box.y + box.height <= viewport.height), true);
        await page.screenshot({ path: path.join(evidenceDir, `verifier-create-refresh-failure-${viewport.name}.png`), fullPage: true });
      }
      await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
      await page.locator('.agent-control-room-board').waitFor();
      assert.equal(await page.getByLabel('에이전트에게 작업 지시').evaluate((element) => element === document.activeElement), true);
    });
    await check('dead-drawer-contract', async () => {
      const drawer = fs.readFileSync(path.resolve('apps/desktop/src/features/agent-operations/AgentWorkDrawer.tsx'), 'utf8');
      const styles = fs.readFileSync(path.resolve('apps/desktop/src/features/agent-operations/agent-workspace.css'), 'utf8');
      assert.doesNotMatch(drawer, /agent-work-scrim|agent-work-drawer/);
      assert.doesNotMatch(styles, /agent-work-scrim|agent-work-drawer/);
      assert.equal(await page.locator('.agent-work-scrim, .agent-work-drawer').count(), 0);
    });
    if (failures.length) throw new Error(failures.join('\n'));
    console.log(JSON.stringify({ ok: true, checks: 6 }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
