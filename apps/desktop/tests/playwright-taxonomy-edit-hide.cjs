const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const taxonomyRecord = (overrides = {}) => ({
  id: 'taxonomy-list-coursework',
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
  notes: JSON.stringify({ id: 'coursework', label: 'Coursework', icon: '🎓', group: 'School', kind: 'list', recordId: 'taxonomy-list-coursework' }),
  ...overrides,
});

const state = {
  taxonomy: [taxonomyRecord()],
  tasks: [
    { id: 'task-coursework', title: 'Taxonomy scoped task', date: '2026-07-04', status: 'Planned', owner: 'Me', category: 'Coursework', project: 'Coursework' },
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
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'PATCH') {
      const id = decodeURIComponent(taskMatch[1]);
      if (id === 'taxonomy-list-coursework') {
        state.taxonomy = [taxonomyRecord({ ...body, id })];
      } else {
        state.tasks = state.tasks.map((task) => task.id === id ? { ...task, ...body } : task);
      }
      await route.fulfill({ json: { ok: true, task: id === 'taxonomy-list-coursework' ? state.taxonomy[0] : state.tasks.find((task) => task.id === id) } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [...state.taxonomy, ...state.tasks],
        events: [],
        agents: [{ id: 'default', name: 'default', displayName: 'Default Hermes', status: 'ready' }],
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

  await page.locator('.taxonomy-manager').getByRole('button', { name: '편집', exact: true }).click();
  await page.waitForSelector('.taxonomy-modal');
  await page.locator('.taxonomy-field input').fill('Coursework Edited');
  await page.locator('.taxonomy-group-input').fill('School Edited');
  await page.getByRole('button', { name: '저장' }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.nav-item')).some((item) => item.textContent?.includes('Coursework Edited')));

  await page.locator('.nav-item').filter({ hasText: 'Coursework Edited' }).click();
  await page.waitForSelector('.taxonomy-manager');
  await page.locator('.taxonomy-manager').getByRole('button', { name: '숨김', exact: true }).click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('.nav-item')).some((item) => item.textContent?.includes('Coursework Edited')));

  const editCall = calls.find((call) => call.method === 'PATCH' && call.path === '/api/tasks/taxonomy-list-coursework' && call.body.label === 'Coursework Edited');
  const hideCall = calls.find((call) => call.method === 'PATCH' && call.path === '/api/tasks/taxonomy-list-coursework' && call.body.hidden === true);

  assert.equal(Boolean(editCall), true);
  assert.equal(editCall.body.group, 'School Edited');
  assert.equal(Boolean(hideCall), true);
  assert.equal(hideCall.body.status, 'Hidden');
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, edit: editCall.body, hide: hideCall.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
