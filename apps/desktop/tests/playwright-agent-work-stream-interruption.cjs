const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const evidenceDir = process.env.EVIDENCE_DIR || path.resolve('.omo/evidence/agent-work-stream-interruption');
const createdAt = '2026-07-19T00:00:00.000Z';
const missionId = 'work-interruption';
const missionThreadId = 'thread-interruption';
const secondMissionId = 'work-interruption-second';
const secondMissionThreadId = 'thread-interruption-second';

const mission = {
  id: missionId,
  templateId: 'general-agent-work',
  title: '실시간 응답 중단 재현',
  objective: '부분 응답이 남고 재시도 안내가 보이는지 확인한다.',
  successCriteria: [],
  agentId: 'bizconsultant',
  executionEngine: 'auto',
  deliverable: { kind: 'report', format: 'markdown' },
  status: 'draft',
  timezone: 'Asia/Seoul',
  sources: [],
  reportSchedule: { weekday: 5, hour: 16, minute: 0 },
  policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: [] },
  budget: { usedRuns: 0, usedMinutes: 0, weekStartedAt: createdAt },
  missionThreadId,
  planSummary: '',
  plannedAt: '',
  createdAt,
  updatedAt: createdAt,
};

const secondMission = {
  ...mission,
  id: secondMissionId,
  title: '두 번째 작업 대화',
  objective: '첫 번째 작업의 실시간 상태가 섞이지 않는지 확인한다.',
  missionThreadId: secondMissionThreadId,
};

const operationState = {
  missions: [mission, secondMission],
  tasks: [],
  sessions: [],
  reports: [],
  daemon: { running: true, lastRun: createdAt, lastError: null },
};

function workPayload(targetMission = mission) {
  const targetMissionThreadId = targetMission.missionThreadId;
  return {
    id: targetMission.id,
    templateId: targetMission.templateId,
    title: targetMission.title,
    objective: targetMission.objective,
    status: targetMission.status,
    agentId: targetMission.agentId,
    assignmentReason: `explicit:${targetMission.agentId}`,
    executionEngine: targetMission.executionEngine,
    resolvedExecutionEngine: 'codex',
    deliverable: targetMission.deliverable,
    missionThreadId: targetMissionThreadId,
    workConversationId: targetMissionThreadId,
    revisionCounter: 1,
    pendingRevisionId: '',
    currentResultReportId: '',
    createdAt,
    updatedAt: createdAt,
  };
}

function conversationPayload(targetMission = mission) {
  const targetWork = workPayload(targetMission);
  return {
    ok: true,
    work: targetWork,
    conversation: {
      id: targetMission.missionThreadId,
      missionId: targetMission.id,
      taskId: '',
      type: 'mission-thread',
      title: targetMission.title,
      status: 'draft',
      pendingInstructions: [],
      executionEngine: targetMission.executionEngine,
      deliverable: targetMission.deliverable,
      createdAt,
      updatedAt: createdAt,
    },
    checkpoints: [],
    nextCursor: null,
  };
}

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve('apps/desktop'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const { server, url } = await startVite();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const calls = [];
  try {
    await page.addInitScript(({ targetMissionId }) => {
      const originalFetch = window.fetch.bind(window);
      window.__previousMissionLateErrorDelivered = false;
      window.fetch = async (input, init = {}) => {
        const requestUrl = typeof input === 'string' ? input : input.url;
        const pathName = new URL(requestUrl, window.location.href).pathname;
        if (pathName !== `/api/agent-operations/work/${targetMissionId}/live`) return originalFetch(input, init);
        const body = JSON.parse(String(init.body || '{}'));
        if (body.text !== '전환 중 응답') return originalFetch(input, init);

        const encoder = new TextEncoder();
        const frame = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(frame('accepted', {
              delivery: { status: 'accepted', applicationMode: 'mission_context', acceptedAt: '2026-07-19T00:00:00.000Z' },
              idempotentReplay: false,
            }));
            controller.enqueue(frame('delta', { text: '전환 전 부분 응답입니다.' }));
            setTimeout(() => {
              controller.enqueue(frame('error', { code: 'stream_interrupted', message: '늦게 도착한 이전 작업 오류입니다.' }));
              window.__previousMissionLateErrorDelivered = true;
              controller.close();
            }, 800);
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
      };
    }, { targetMissionId: missionId });

    await page.route('**/*', async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const apiPath = requestUrl.pathname;
      if (!apiPath.startsWith('/api/')) {
        await route.continue();
        return;
      }
      const method = request.method();
      calls.push({ method, path: apiPath });
      if (method === 'GET' && apiPath === '/api/agent-operations') {
        await route.fulfill({ json: operationState });
        return;
      }
      if (method === 'GET' && apiPath === '/api/agents') {
        await route.fulfill({ json: { ok: true, agents: [{ id: mission.agentId, displayName: 'Business Consultant', status: 'ready', enabled: true, provider: 'Hermes' }] } });
        return;
      }
      const conversationMatch = apiPath.match(/^\/api\/agent-operations\/work\/([^/]+)\/conversation$/);
      if (method === 'GET' && conversationMatch) {
        const requestedMissionId = decodeURIComponent(conversationMatch[1]);
        const requestedMission = [mission, secondMission].find((item) => item.id === requestedMissionId);
        assert.ok(requestedMission, `unexpected mission conversation request: ${requestedMissionId}`);
        await route.fulfill({ json: conversationPayload(requestedMission) });
        return;
      }
      const liveMatch = apiPath.match(/^\/api\/agent-operations\/work\/([^/]+)\/live$/);
      if (method === 'POST' && liveMatch) {
        assert.equal(decodeURIComponent(liveMatch[1]), missionId);
        const body = request.postDataJSON();
        assert.equal(body.text, '중단 재현 메시지');
        const delivery = { status: 'accepted', applicationMode: 'mission_context', acceptedAt: createdAt };
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          // Deliberately close after a partial delta: no error and no done event.
          body: sse('accepted', { delivery, idempotentReplay: false }) + sse('delta', { text: '부분 응답입니다.' }),
        });
        return;
      }
      await route.fulfill({ json: {} });
    });

    await page.goto(url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    const card = page.locator(`[data-work-mission="${missionId}"]`).first();
    await card.waitFor();
    await card.click();
    await page.locator('.agent-work-header h1').waitFor();
    await page.getByText('아직 체크포인트가 없습니다.', { exact: false }).waitFor();

    const composer = page.getByLabel('작업 대화 메시지');
    await composer.fill('중단 재현 메시지');
    await composer.press('Enter');
    await page.getByText('부분 응답입니다.', { exact: false }).waitFor();

    // A clean but truncated stream must become a retryable interruption instead
    // of leaving the Work Conversation in an active state forever.
    await page.waitForFunction(() => {
      const live = document.querySelector('.agent-work-live-turn');
      const partial = live?.querySelector('.agent-work-live-partial')?.textContent?.replace(/\s+/g, ' ');
      return Boolean(
        live
        && live.getAttribute('data-kind') === 'error'
        && partial?.includes('부분 응답입니다.')
        && live.querySelector('.agent-work-live-error-copy')?.textContent?.includes('다시 시도'),
      );
    }, null, { timeout: 2_000 });

    assert.equal(await page.locator('.agent-work-live-turn').getAttribute('data-kind'), 'error');
    assert.match((await page.locator('.agent-work-live-partial').textContent() || '').replace(/\s+/g, ' '), /부분 응답입니다/);
    assert.match(await page.locator('.agent-work-live-error-copy').textContent() || '', /다시 시도/);
    assert.equal(await page.locator('[aria-label="작업 대화에 보내기"]').textContent(), '보내기');

    await composer.fill('전환 중 응답');
    await composer.press('Enter');
    await page.getByText('전환 전 부분 응답입니다.', { exact: false }).waitFor();
    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    await page.locator('.agent-control-head h1').waitFor();
    await page.locator(`[data-work-mission="${secondMissionId}"]`).first().click();
    await page.locator('.agent-work-header h1', { hasText: secondMission.title }).waitFor();
    await page.getByText('아직 체크포인트가 없습니다.', { exact: false }).waitFor();

    // A live turn belongs to one selected Work Conversation. Returning to
    // Control Home and opening another mission must not carry over the first
    // mission's partial response or interruption error.
    const leakedLiveTurnCount = await page.locator('.agent-work-live-turn').count();
    const leakedPartialCount = await page.getByText('부분 응답입니다.', { exact: false }).count();
    const leakedErrorCount = await page.getByText('다시 시도해 주세요.', { exact: false }).count();
    const leakedLiveTurnText = (await page.locator('.agent-work-live-turn').allTextContents()).join(' ').replace(/\s+/g, ' ').trim();
    assert.equal(leakedLiveTurnCount, 0, JSON.stringify({ leakedLiveTurnCount, leakedPartialCount, leakedErrorCount, leakedLiveTurnText }));
    assert.equal(leakedPartialCount, 0, JSON.stringify({ leakedLiveTurnCount, leakedPartialCount, leakedErrorCount, leakedLiveTurnText }));
    assert.equal(leakedErrorCount, 0, JSON.stringify({ leakedLiveTurnCount, leakedPartialCount, leakedErrorCount, leakedLiveTurnText }));
    await page.waitForFunction(() => window.__previousMissionLateErrorDelivered === true);
    assert.equal(await page.locator('.agent-work-live-turn').count(), 0, 'a late terminal event from the previous mission must stay hidden');
    assert.equal(await page.getByText('전환 전 부분 응답입니다.', { exact: false }).count(), 0);
    assert.equal(await page.getByText('늦게 도착한 이전 작업 오류입니다.', { exact: false }).count(), 0);
    fs.writeFileSync(path.join(evidenceDir, 'result.json'), JSON.stringify({ ok: true, calls }, null, 2));
    console.log(JSON.stringify({ ok: true, calls }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'failure.json'), JSON.stringify({ ok: false, name: error?.name, message: error?.message, stack: error?.stack }, null, 2));
  console.error(error);
  process.exit(1);
});
