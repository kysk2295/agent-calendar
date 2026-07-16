const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }

    const method = request.method();
    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method, path, body });

    if (method === 'POST' && path === '/api/chat/stream') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: ['event: delta', 'data: {"text":"CALENDAR_REPLY_SENTINEL"}', '', 'event: done', 'data: {"text":"CALENDAR_REPLY_SENTINEL"}', '', ''].join('\n'),
      });
      return;
    }

    if (method === 'GET' && path === '/api/chat/messages') {
      await route.fulfill({
        json: {
          messages: [
            { id: 'schedule-history', role: 'assistant', text: 'SCHEDULE_HISTORY_SENTINEL', source: 'schedule-assistant', target: 'calendar' },
            { id: 'legacy-schedule-history', role: 'assistant', text: 'LEGACY_SCHEDULE_SENTINEL', source: 'schedule-assistant' },
            { id: 'runtime-history', role: 'assistant', text: 'GENERAL_HISTORY_SENTINEL', source: 'chat', target: 'runtime' },
          ],
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [],
        runs: [{ id: 'raw-run', goal: 'INTERNAL_MISSION_SENTINEL', status: 'done', agent: 'bizconsultant' }],
        documents: [],
        chatMessages: [],
        notes: [],
        graph: { nodes: [], edges: [] },
        items: [],
        commands: [],
        jobs: [],
        messages: [],
        channels: [],
        tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  // Given: schedule history exists beside unrelated runtime history and a raw run goal.
  await page.goto(target);

  // When: the user opens the calendar AI drawer and sends non-question text.
  await page.locator('.chat-fab').click();
  assert.equal(await page.locator('.chat header strong').textContent(), '캘린더 AI');
  assert.equal(await page.locator('.chat header span').textContent(), '일정 Q&A · 추천');
  assert.doesNotMatch(await page.locator('.chat header').textContent() || '', /콘솔|Railway|stream/i);
  assert.deepEqual(await page.locator('.chat-chips button').allTextContents(), [
    '이번 주 완료율?',
    '오늘 할 일 정리해줘',
    '이번 주 빈 시간 알려줘',
  ]);
  assert.equal(await page.locator('.chat textarea').getAttribute('placeholder'), '일정이나 할 일을 물어보세요');
  await page.locator('.chat textarea').fill('주간 계획 정리');
  await page.getByRole('button', { name: '전송' }).click();
  await page.waitForFunction(() => document.querySelector('.messages')?.textContent?.includes('CALENDAR_REPLY_SENTINEL'));

  // Then: only schedule conversation is shown and the request declares the calendar view.
  const drawerText = await page.locator('.chat').textContent() || '';
  assert.match(drawerText, /SCHEDULE_HISTORY_SENTINEL/);
  assert.doesNotMatch(drawerText, /INTERNAL_MISSION_SENTINEL|LEGACY_SCHEDULE_SENTINEL|GENERAL_HISTORY_SENTINEL/);
  assert.equal(await page.locator('.chat-run-card').count(), 0);
  const streamCall = calls.find((call) => call.method === 'POST' && call.path === '/api/chat/stream');
  assert.equal(streamCall?.body.view, 'calendar');

  await browser.close();
  console.log(JSON.stringify({ ok: true, view: streamCall?.body.view }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
