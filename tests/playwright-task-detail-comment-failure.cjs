const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const state = {
  tasks: [
    {
      id: 'task-detail-comment-fail',
      title: '상세 댓글 실패 보존 작업',
      date: '2026-07-04',
      status: 'Planned',
      owner: 'Me',
      category: '기본함',
      project: '기본함',
      list: '기본함',
      notes: '초기 메모',
    },
  ],
};

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

    if (method === 'PATCH' && path === '/api/tasks/task-detail-comment-fail') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'comment patch failed' } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
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
        channels: [],
        tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  await page.goto(target);
  await page.getByRole('button', { name: '📥 기본함' }).click();
  await page.waitForSelector('.task-row');

  await page.locator('.task-row', { hasText: '상세 댓글 실패 보존 작업' }).dblclick();
  await page.waitForSelector('.detail-modal');

  await page.locator('.detail-tool[title="댓글"]').click();
  await page.locator('.detail-tool-popover input').fill('실패해도 남는 상세 댓글');
  await page.locator('.detail-tool-popover').getByRole('button', { name: '남기기' }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.detail-tool-popover').count(), 1);
  assert.equal(await page.locator('.detail-tool-popover input').inputValue(), '실패해도 남는 상세 댓글');
  assert.equal(calls.some((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-detail-comment-fail'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, patchCalls: calls.filter((call) => call.method === 'PATCH') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
