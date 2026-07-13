const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const agents = [
  { id: 'default', name: 'default', displayName: 'Default Hermes', status: 'Idle', model: 'grok-4.3', profile: { name: 'default', gateway: 'running' } },
  { id: 'stockagent', name: 'stockagent', displayName: 'Stock Agent', status: 'Idle', model: 'gpt-5.5', profile: { name: 'stockagent', gateway: 'running' } },
];

const profileReadiness = {
  allReady: false,
  requiredProfiles: [
    { profile: 'default', present: true, status: 'ready', setup: { profile: 'default', dashboard: { localUrl: 'http://127.0.0.1:9119/' } } },
    { profile: 'stockagent', present: true, status: 'ready', setup: { profile: 'stockagent' } },
    { profile: 'marketflow', present: false, status: 'missing', setup: { profile: 'marketflow' } },
  ],
};

const runs = [
  { id: 'run-default', title: '현재 에이전트 실행', agent: 'default', status: 'done', step: '완료' },
  { id: 'run-marketflow', title: '삭제된 에이전트 실행', agent: 'marketflow', status: 'done', step: '완료' },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && path === '/api/state') {
      await route.fulfill({ json: { ok: true, tasks: [], events: [], agents, runs, documents: [], chatMessages: [], profileReadiness, agentSourceStatus: { ok: true, source: 'hermes-cli-dashboard', profileCount: 3 } } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents } });
      return;
    }
    await route.fulfill({ json: { ok: true, data: {}, tasks: [], events: [], documents: [], notes: [], graph: { nodes: [], edges: [] }, items: [], commands: [], jobs: [], messages: [], channels: [], tools: [], settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } }, uiPreferences: { notify: true, agentShare: true, weekStartMon: true } } });
  });

  await page.goto(target);
  await page.waitForSelector('.app-root');
  await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
  await page.waitForSelector('.agent-operations-workspace');
  await page.getByRole('tab', { name: 'Agents' }).click();
  await page.waitForSelector('.agent-roster-row');

  const gridText = await page.locator('.agent-roster-list').textContent();
  assert.match(gridText || '', /Default Hermes/);
  assert.match(gridText || '', /준비됨/);
  assert.doesNotMatch(gridText || '', /marketflow/);
  assert.doesNotMatch(gridText || '', /누락/);
  assert.doesNotMatch(gridText || '', /대기/);

  await browser.close();
  console.log(JSON.stringify({ ok: true, statuses: ['준비됨'], hiddenMissingProfiles: ['marketflow'] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
