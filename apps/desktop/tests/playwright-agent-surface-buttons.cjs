const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const agents = [
  {
    id: 'default',
    name: 'default',
    displayName: 'Default Hermes',
    status: '준비됨',
    model: 'Recommended',
    role: '기본 실행 담당',
    provider: 'Mac mini Hermes',
    trustLevel: '개인 승인',
    allowedTaskClasses: ['research'],
  },
  {
    id: 'bizconsultant',
    name: 'bizconsultant',
    displayName: 'Business Consultant',
    status: '준비됨',
    model: 'Recommended',
    role: '시장 변화와 사업 기회를 검증합니다.',
    provider: 'Mac mini Hermes',
    trustLevel: '개인 승인',
    allowedTaskClasses: ['research', 'analysis', 'report'],
  },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && pathname === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents } });
      return;
    }
    if (request.method() === 'GET' && pathname === '/api/agent-operations') {
      await route.fulfill({ json: { ok: true, missions: [], tasks: [], sessions: [], reports: [] } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents,
        runs: [],
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

  await page.goto(target);
  await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
  await page.waitForSelector('.agent-control-room');

  assert.equal(await page.locator('.agent-operations-tabs').count(), 0);
  assert.equal(await page.locator('.agent-status-card').count(), 2);
  assert.match(await page.locator('.agent-status-grid').textContent() || '', /Default Hermes/);
  assert.match(await page.locator('.agent-status-grid').textContent() || '', /Business Consultant/);
  assert.doesNotMatch(await page.locator('.agent-status-grid').textContent() || '', /marketflow/i);
  assert.equal(await page.getByRole('button', { name: '+ 새 에이전트' }).count(), 0);

  assert.equal(await page.getByRole('button', { name: '새 작업' }).count(), 0);
  assert.equal(await page.getByLabel('에이전트에게 작업 지시').count(), 1);
  assert.equal(await page.getByRole('tab', { name: '보고서' }).count(), 0);
  assert.equal(await page.getByRole('tab', { name: '미션' }).count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, tabs: 0, agents: agents.map((agent) => agent.id) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
