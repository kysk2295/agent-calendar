const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const todayKey = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const addDaysKey = (key, offset) => {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

const TODAY = todayKey();
const LAST_WEEK = addDaysKey(TODAY, -8);

const tasks = [
  { id: 'done-a', title: '이번 주 완료 A', date: TODAY, status: 'Done', done: true, owner: 'Me', category: '기본함', notes: '' },
  { id: 'done-b', title: '이번 주 완료 B', date: TODAY, status: 'Done', done: true, owner: 'Me', category: '기본함', notes: '' },
  { id: 'todo-a', title: '이번 주 미완 A', date: TODAY, status: 'Planned', done: false, owner: 'Me', category: '기본함', notes: '' },
  { id: 'old-done', title: '지난주 완료', date: LAST_WEEK, status: 'Done', done: true, owner: 'Me', category: '기본함', notes: '' },
];

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

    if (method === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, tasks, data: { tasks } } });
      return;
    }

    if (method === 'POST' && path === '/api/chat/stream') {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ['data: {"text":"일반 채팅 응답"}', ''].join('\n'),
      });
      return;
    }

    if (method === 'POST' && path === '/api/assistant/ask') {
      await route.fulfill({
        json: {
          ok: true,
          answer: '이번 주 완료율은 67%입니다. 2/3 완료 상태이고, 근거: 이번 주 작업 3개를 사용했어요.',
          llm: { provider: 'local-llm', model: 'qwen2.5:7b', used: true },
          search: { strategy: 'backend-calendar-ai-rag' },
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks,
        events: [],
        agents: [],
        runs: [],
        documents: [],
        notes: [],
        graph: { nodes: [], edges: [] },
        items: [],
        commands: [],
        jobs: [],
        messages: [],
        chatMessages: [],
        channels: [],
        tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  await page.goto(target);
  await page.waitForSelector('.chat-fab');
  await page.locator('.chat-fab').click();
  await page.waitForSelector('.chat');

  await page.locator('.chat textarea').fill('이번 주 완료율?');
  await page.getByRole('button', { name: '전송' }).click();
  await page.waitForFunction(() => document.querySelector('.messages')?.textContent?.includes('완료율은 67%'));

  const result = await page.evaluate(() => ({
    input: document.querySelector('.chat textarea')?.value || '',
    messages: document.querySelector('.messages')?.textContent?.replace(/\s+/g, ' ').trim() || '',
  }));

  const streamCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream');
  const scheduleCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/assistant/ask');
  assert.equal(streamCalls.length, 0);
  assert.equal(scheduleCalls.length, 1);
  assert.match(result.messages, /이번 주 완료율\?/);
  assert.match(result.messages, /완료율은 67%/);
  assert.match(result.messages, /2\/3 완료/);
  assert.match(result.messages, /근거: 이번 주 작업 3개/);
  assert.equal(result.input, '');

  await browser.close();
  console.log(JSON.stringify({ ok: true, result }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
