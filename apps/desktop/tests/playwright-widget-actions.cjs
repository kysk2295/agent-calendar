const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const TODAY = '2026-07-04';

const state = {
  tasks: [
    { id: 'task-widget', title: 'Widget action task', date: TODAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함' },
  ],
  events: [],
  runs: [
    { id: 'run-widget', title: 'Widget action run', goal: 'Widget run goal', agent: 'default', status: 'running', progress: 42 },
  ],
};

const calls = [];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.addInitScript(() => {
    let actions = [
      { id: 'toggle-1', type: 'toggleTask', taskID: 'task-widget', source: 'task', done: true, createdAt: '2026-07-04T00:00:01.000Z' },
      { id: 'screen-1', type: 'openScreen', screen: 'widgets', createdAt: '2026-07-04T00:00:02.000Z' },
      { id: 'run-1', type: 'openRun', runID: 'run-widget', createdAt: '2026-07-04T00:00:03.000Z' },
    ];
    window.__clearedWidgetActionIds = [];
    window.hermesDesktop = {
      getSettings: async () => ({ apiBaseUrl: '', hasApiToken: false, theme: 'default', authProfile: { email: 'widget@example.com', name: 'Widget QA' }, uiPreferences: { notify: true, agentShare: true, weekStartMon: true } }),
      saveSettings: async (settings) => ({ apiBaseUrl: '', hasApiToken: false, theme: settings.theme || 'default', uiPreferences: settings.uiPreferences || { notify: true, agentShare: true, weekStartMon: true } }),
      getHermesConnection: async () => ({ baseUrl: '', credential: '' }),
      saveWidgetSnapshot: async () => ({ ok: true, path: '/tmp/widget.json', changed: true }),
      readWidgetActions: async () => actions,
      clearWidgetActions: async (ids) => {
        window.__clearedWidgetActionIds.push(...ids);
        actions = actions.filter((action) => !ids.includes(action.id));
        return { ok: true, cleared: ids.length };
      },
      onWidgetActionsAvailable: (callback) => {
        const timer = setTimeout(callback, 50);
        return () => clearTimeout(timer);
      },
    };
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }

    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method: request.method(), path, body });

    if (request.method() === 'PATCH' && path === '/api/tasks/task-widget') {
      state.tasks[0] = { ...state.tasks[0], ...body };
      await route.fulfill({ json: { ok: true, task: state.tasks[0] } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
        events: state.events,
        agents: [{ id: 'default', name: 'default', displayName: 'Default Hermes', status: 'ready' }],
        runs: state.runs,
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
  await page.waitForFunction(() => window.__clearedWidgetActionIds?.length === 3, null, { timeout: 8000 });

  const result = await page.evaluate(() => ({
    heading: document.querySelector('.screen-heading strong')?.textContent?.trim() || '',
    runModal: document.querySelector('.run-modal')?.textContent?.trim() || '',
    cleared: window.__clearedWidgetActionIds,
    apiBanner: document.querySelector('.api-banner')?.textContent?.trim() || '',
  }));

  assert.equal(calls.some((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-widget' && call.body.done === true), true);
  assert.deepEqual(result.cleared.sort(), ['run-1', 'screen-1', 'toggle-1']);
  assert.match(result.runModal, /Widget action run|Widget run goal/);
  assert.equal(result.apiBanner, '');

  await browser.close();
  console.log(JSON.stringify({ ok: true, result, patchCalls: calls.filter((call) => call.method === 'PATCH') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
