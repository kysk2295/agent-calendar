const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const TODAY = '2026-07-04';
const TOMORROW = '2026-07-05';

const state = {
  tasks: [
    { id: 'task-widget-open', title: 'Widget opened task detail', date: TOMORROW, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함' },
  ],
  events: [
    { id: 'event-widget-open', title: 'Widget opened calendar event', date: TOMORROW, startDate: TOMORROW, time: '10:00', status: 'Planned', owner: 'Me', kind: 'calendar-event' },
  ],
  runs: [],
};

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.addInitScript(() => {
    let actions = [
      { id: 'date-1', type: 'openDate', date: '2026-07-05', createdAt: '2026-07-04T00:00:01.000Z' },
      { id: 'task-1', type: 'openTask', taskID: 'task-widget-open', source: 'task', createdAt: '2026-07-04T00:00:02.000Z' },
    ];
    window.__clearedWidgetActionIds = [];
    window.hermesDesktop = {
      getSettings: async () => ({ apiBaseUrl: '', hasApiToken: false, theme: 'default', authProfile: { email: 'widget@example.com', name: 'Widget QA' }, uiPreferences: { notify: true, agentShare: true, weekStartMon: true } }),
      saveSettings: async (settings) => ({ apiBaseUrl: '', hasApiToken: false, theme: settings.theme || 'default', uiPreferences: settings.uiPreferences || { notify: true, agentShare: true, weekStartMon: true } }),
      getProxyBaseUrl: async () => '',
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
  await page.waitForFunction(() => window.__clearedWidgetActionIds?.length === 2, null, { timeout: 8000 });

  const result = await page.evaluate(() => ({
    heading: document.querySelector('.screen-heading strong')?.textContent?.trim() || '',
    modalTitle: document.querySelector('.detail-modal .detail-title-input')?.value || '',
    modalText: document.querySelector('.detail-modal')?.textContent?.trim() || '',
    cleared: window.__clearedWidgetActionIds,
    apiBanner: document.querySelector('.api-banner')?.textContent?.trim() || '',
  }));

  assert.deepEqual(result.cleared.sort(), ['date-1', 'task-1']);
  assert.match(result.heading, /다음 7일|기본함|오늘/);
  assert.equal(result.modalTitle, 'Widget opened task detail');
  assert.equal(result.apiBanner, '');

  await browser.close();
  console.log(JSON.stringify({ ok: true, result }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
