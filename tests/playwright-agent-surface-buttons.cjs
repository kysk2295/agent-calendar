const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];

let serverAgents = [
  { id: 'default', name: 'default', displayName: 'Default Agent', emoji: '🤖', status: 'ready', model: 'gpt-5', role: '기본 실행 담당' },
  { id: 'researcher', name: 'researcher', displayName: 'Research Agent', emoji: '🔎', status: 'ready', model: 'gpt-5', role: '리서치 담당' },
];

const runs = [
  { id: 'run-research', title: 'Research run surface', goal: '자료 조사', agent: 'Research Agent', status: 'running', step: '검색 중', progress: 42 },
  { id: 'run-default', title: 'Default run surface', goal: '기본 작업', agent: 'Default Agent', status: 'done', step: '완료', progress: 100 },
];

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

    if (method === 'GET' && path === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents: serverAgents } });
      return;
    }
    if (method === 'POST' && path === '/api/agents') {
      const created = { id: 'surface-agent', name: body.name, displayName: body.displayName, emoji: body.emoji, role: body.role, status: 'ready', source: 'server' };
      serverAgents = [created, ...serverAgents];
      await route.fulfill({ json: { ok: true, agent: created } });
      return;
    }
    if (method === 'POST' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, task: { id: 'task-agent-surface', title: body.title, status: body.status } } });
      return;
    }
    if (method === 'POST' && path === '/api/missions/launch') {
      await route.fulfill({ json: { ok: true, run: { id: 'run-agent-surface-new', title: 'Surface mission run', goal: body.goal, agent: body.agentId, status: 'running', progress: 7 } } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: serverAgents,
        runs,
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
  await page.waitForSelector('.mission');

  await page.locator('.mission-examples button', { hasText: '이번 주 트레이딩 회고 문서 작성' }).click();
  assert.equal(await page.locator('.mission textarea').inputValue(), '이번 주 트레이딩 회고 문서 작성');

  await page.locator('.agent-chip', { hasText: 'Research Agent' }).click();
  assert.equal(await page.locator('.agent-chip[data-active="true"]').textContent(), '🔎 Research Agent');
  await page.locator('.agent-card', { hasText: 'Default Agent' }).click();
  assert.match(await page.locator('.agent-card[data-active="true"]').textContent() || '', /Default Agent/);

  await page.locator('.run-row', { hasText: 'Research run surface' }).click();
  await page.waitForSelector('.run-modal');
  assert.match(await page.locator('.run-modal').textContent() || '', /Research run surface/);
  await page.locator('.run-head button').click();
  await page.waitForFunction(() => !document.querySelector('.run-modal'));

  await page.getByRole('button', { name: '+ 새 에이전트' }).click();
  await page.waitForSelector('.agent-modal');
  await page.locator('.agent-emoji-grid').getByRole('button', { name: '📊' }).click();
  await page.locator('.agent-modal input').fill('Surface Agent');
  await page.locator('.agent-modal textarea').fill('표면 버튼 감사 담당');
  await page.locator('.agent-modal').getByRole('button', { name: '만들기', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.agent-modal'));
  await page.waitForSelector('.agent-card:has-text("Surface Agent")');

  const createCall = calls.find((call) => call.method === 'POST' && call.path === '/api/agents');
  assert.equal(Boolean(createCall), true);
  assert.equal(createCall.body.name, 'Surface Agent');
  assert.equal(createCall.body.emoji, '📊');
  assert.equal(createCall.body.role, '표면 버튼 감사 담당');

  await page.locator('.agent-chip', { hasText: 'Surface Agent' }).click();
  await page.locator('.mission textarea').fill('생성된 에이전트로 실행');
  await page.getByRole('button', { name: /계획 세우기/ }).click();
  await page.waitForSelector('.run-modal');

  const launchCall = calls.findLast((call) => call.method === 'POST' && call.path === '/api/missions/launch');
  assert.equal(Boolean(launchCall), true);
  assert.equal(launchCall.body.goal, '생성된 에이전트로 실행');
  assert.equal(launchCall.body.agentId, 'surface-agent');

  await browser.close();
  console.log(JSON.stringify({ ok: true, createdAgent: createCall.body.name, launchAgent: launchCall.body.agentId }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
