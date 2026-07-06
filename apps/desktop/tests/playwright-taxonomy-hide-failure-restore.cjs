const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const taxonomyRecord = (overrides = {}) => ({
  id: 'taxonomy-list-coursework-hide-fail',
  title: '__agents_calendar_list:Coursework',
  label: 'Coursework',
  name: 'Coursework',
  slug: 'coursework',
  icon: '🎓',
  group: 'School',
  kind: 'taxonomy',
  type: 'taxonomy',
  taxonomyKind: 'list',
  source: 'hermes-desktop-taxonomy',
  project: 'Agent Calendar Metadata',
  status: 'Active',
  tags: ['hermes-meta'],
  hidden: false,
  notes: JSON.stringify({ id: 'coursework', label: 'Coursework', icon: '🎓', group: 'School', kind: 'list', recordId: 'taxonomy-list-coursework-hide-fail' }),
  ...overrides,
});

const state = {
  taxonomy: [taxonomyRecord()],
  tasks: [
    { id: 'task-coursework-hide-fail', title: 'Hide failure scoped task', date: '2026-07-04', status: 'Planned', owner: 'Me', category: 'Coursework', project: 'Coursework' },
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

    if (method === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, tasks: [...state.taxonomy, ...state.tasks], data: { tasks: [...state.taxonomy, ...state.tasks] } } });
      return;
    }

    if (method === 'PATCH' && path === '/api/tasks/taxonomy-list-coursework-hide-fail' && body.hidden === true) {
      await route.fulfill({ status: 500, json: { ok: false, error: 'taxonomy hide failed' } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [...state.taxonomy, ...state.tasks],
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
  await page.waitForSelector('.app-root');
  await page.locator('.nav-item').filter({ hasText: 'Coursework' }).click();
  await page.waitForSelector('.taxonomy-manager');

  await page.locator('.taxonomy-manager').getByRole('button', { name: '숨김', exact: true }).click();
  await page.waitForSelector('.api-banner');

  const activeNavText = await page.locator('.nav-item[data-active="true"]').textContent();
  assert.match(activeNavText || '', /Coursework/);
  assert.equal(await page.locator('.taxonomy-manager').count(), 1);
  assert.match(await page.locator('.taxonomy-manager').textContent(), /Coursework/);
  assert.equal(calls.some((call) => call.method === 'PATCH' && call.path === '/api/tasks/taxonomy-list-coursework-hide-fail' && call.body.hidden === true), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, activeNavText, hideCalls: calls.filter((call) => call.method === 'PATCH') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
