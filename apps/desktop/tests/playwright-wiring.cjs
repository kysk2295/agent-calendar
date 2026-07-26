const assert = require('node:assert/strict');
const { writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];
const createdEvents = [];

async function main() {
  const imagePath = path.join(os.tmpdir(), `agent-calendar-ingest-${Date.now()}.png`);
  await writeFile(imagePath, Buffer.from('fake-png'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  await page.addInitScript(() => {
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: '',
        hasApiToken: false,
        hasSession: true,
        theme: 'default',
        authProfile: {
          provider: 'authkit',
          id: 'schedule-ingest-qa',
          email: 'schedule-ingest@example.test',
          name: 'Schedule Ingest QA',
          updatedAt: '2026-07-25T00:00:00.000Z',
        },
        session: {
          signedIn: true,
          workspaceId: 'workspace-schedule-ingest-qa',
          userId: 'schedule-ingest-qa',
          role: 'owner',
        },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      }),
      getSessionStatus: async () => ({
        signedIn: true,
        sessionId: 'session-schedule-ingest-qa',
        userId: 'schedule-ingest-qa',
        workspaceId: 'workspace-schedule-ingest-qa',
        role: 'owner',
        email: 'schedule-ingest@example.test',
        displayName: 'Schedule Ingest QA',
        accessExpiresAt: null,
      }),
      getHermesConnection: async () => ({ baseUrl: '', credential: '' }),
      getDesktopReleaseStatus: async () => ({
        supported: false,
        phase: 'unsupported',
        currentVersion: '0.1.0',
        availableVersion: null,
        progressPercent: null,
        checkedAt: null,
        message: '테스트 환경',
      }),
      consumeDesktopRecoveryStatus: async () => ({
        phase: 'none',
        crashCount: 0,
        reason: null,
        occurredAt: null,
        message: '',
      }),
      onDesktopReleaseStatus: () => () => {},
      onAuthSessionChanged: () => () => {},
      onAuthLoginError: () => () => {},
    };
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname;
    if (!apiPath.startsWith('/api/')) {
      await route.continue();
      return;
    }

    const method = request.method();
    const rawBody = request.postData() || '';
    let body = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = { rawBody }; }
    calls.push({ method, path: apiPath, body, contentType: request.headers()['content-type'] || '' });

    if (method === 'POST' && apiPath === '/api/assistant/ask') {
      await route.fulfill({ json: {
        ok: true,
        answer: '오늘 일정은 병원 예약과 팀 주간회의입니다.',
        answerMode: 'llm',
        search: { strategy: 'backend-calendar-ai-rag', intent: 'ask' },
        sources: [{ id: 'event-hospital', title: '병원 예약', sourceType: 'calendar-event' }],
      } });
      return;
    }

    if (method === 'POST' && apiPath === '/api/assistant/ingest') {
      await route.fulfill({ json: {
        ok: true,
        drafts: [{
          kind: 'event',
          title: 'OO정형외과 예약',
          date: '2026-07-21',
          start: '10:30',
          end: null,
          location: null,
          notes: '원문: "7/21 오전 10:30 예약"',
          confidence: 'low',
        }],
        warnings: [],
        conflicts: [],
        ingest: { ocrEngine: 'apple-vision' },
        search: { strategy: 'backend-calendar-ai-rag', intent: 'ingest' },
      } });
      return;
    }

    if (method === 'POST' && apiPath === '/api/calendar/events') {
      const event = { id: 'created-event', title: body.title, date: body.date, time: body.time, kind: 'calendar-event' };
      createdEvents.push(event);
      await route.fulfill({ json: { ok: true, event } });
      return;
    }

    if (method === 'GET' && apiPath === '/api/calendar/events') {
      await route.fulfill({ json: { ok: true, events: createdEvents, calendarEvents: createdEvents } });
      return;
    }

    if (method === 'POST' && apiPath === '/api/wiki/search') {
      await route.fulfill({ json: {
        ok: true,
        answerMode: 'retrieval-only',
        retrieval: { source: 'wiki-files', mode: 'retrieval_only' },
        sources: [{ path: '2_wiki/UniPort-시스템구조.md', title: 'UniPort 시스템구조', excerpt: 'Hermes와 Railway 근거' }],
        results: [{ path: '2_wiki/UniPort-시스템구조.md', title: 'UniPort 시스템구조', excerpt: 'Hermes와 Railway 근거' }],
      } });
      return;
    }

    if (method === 'POST' && apiPath === '/api/chat/stream') {
      const answer = body.view === 'wiki'
        ? 'UniPort는 Hermes와 Railway를 근거로 설명됩니다.'
        : '오늘 일정은 병원 예약과 팀 주간회의입니다.';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          'event: delta',
          `data: ${JSON.stringify({ text: answer })}`,
          '',
          'event: done',
          `data: ${JSON.stringify({ text: answer, answerMode: 'llm', sources: body.view === 'wiki' ? [{ path: '2_wiki/UniPort-시스템구조.md' }] : [] })}`,
          '',
        ].join('\n'),
      });
      return;
    }

    await route.fulfill({ json: {
      ok: true,
      tasks: [],
      events: createdEvents,
      agents: [],
      runs: [],
      documents: [{ id: 'wiki-1', title: 'UniPort 시스템구조', wikiPath: '2_wiki/UniPort-시스템구조.md' }],
      notes: [{ path: '2_wiki/UniPort-시스템구조.md', title: 'UniPort 시스템구조', excerpt: 'Hermes와 Railway 근거' }],
      graph: { nodes: [], edges: [] },
      items: [],
      commands: [],
      jobs: [],
      messages: [],
      chatMessages: [],
      channels: [],
      tools: [],
      onboarding: { version: 1, status: 'completed', completedAt: '2026-07-25T00:00:00.000Z' },
      settings: {
        onboarding: { version: 1, status: 'completed', completedAt: '2026-07-25T00:00:00.000Z' },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
      uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
    } });
  });

  try {
    await page.goto(target);
    await page.waitForSelector('.chat-fab');
    await page.waitForTimeout(500);
    if (!await page.locator('.chat-fab').isVisible()) {
      const diagnostics = await page.locator('.chat-fab').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          parentDisplay: getComputedStyle(element.parentElement).display,
          body: document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 800),
        };
      });
      throw new Error(`Calendar AI entry hidden: ${JSON.stringify(diagnostics)}`);
    }

    await page.locator('.chat-fab').click();
    await page.locator('.chat textarea').fill('오늘 일정 요약해줘');
    await page.getByRole('button', { name: '전송' }).click();
    await page.waitForFunction(() => document.querySelector('.messages')?.textContent?.includes('병원 예약'));

    await page.locator('.chat-attach-button input[type="file"]').setInputFiles(imagePath);
    await page.locator('.chat textarea').fill('사진에서 일정 찾아줘');
    await page.getByRole('button', { name: '전송' }).click();
    await page.waitForFunction(() => document.querySelector('.messages')?.textContent?.includes('선택 항목 등록'));
    await page.getByRole('button', { name: '선택 항목 등록' }).click();
    await page.waitForFunction(() => document.querySelector('.messages')?.textContent?.includes('1건 등록했어요'));
    await page.getByRole('button', { name: '캘린더', exact: true }).click();
    await page.getByRole('button', { name: '캘린더 AI 닫기' }).click();
    await page.locator('.calendar-event-pill', { hasText: 'OO정형외과 예약' }).waitFor();

    await page.locator('.nav-more summary').click();
    await page.getByRole('button', { name: '위키', exact: true }).click();
    await page.locator('.askbar input').fill('UniPort 시스템 구조를 설명해줘');
    await page.locator('.askbar button').click();
    await page.waitForFunction(() => document.body.textContent?.includes('Hermes와 Railway'));

    assert.equal(calls.filter((call) => call.path === '/api/assistant/ask').length, 0);
    assert.equal(calls.filter((call) => call.path === '/api/assistant/ingest').length, 1);
    assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/api/calendar/events').length, 1);
    assert.equal(createdEvents.length, 1);
    assert.equal(calls.filter((call) => call.path === '/api/wiki/search').length, 0);
    assert.equal(calls.filter((call) => call.path === '/api/chat/stream').length, 2);
    assert.equal(calls.filter((call) => call.path === '/api/chat/stream' && call.body.view === 'calendar' && /오늘 일정/.test(call.body.message)).length, 1);
    assert.equal(calls.filter((call) => call.path === '/api/chat/stream' && call.body.view === 'wiki' && call.body.agent === 'wikicurator').length, 1);

    await browser.close();
    console.log(JSON.stringify({ ok: true, calls: calls.map(({ method, path }) => ({ method, path })) }, null, 2));
  } finally {
    await rm(imagePath, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
