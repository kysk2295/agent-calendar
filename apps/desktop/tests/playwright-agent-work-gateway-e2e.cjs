const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const { AgentOperationsService } = require('../../backend/app/lib/agent-operations-service');
const { HermesStore } = require('../../backend/app/lib/store');
const { createRailwayGatewayServer } = require('../../backend/app/railway-gateway-server');

const FIXED_NOW = '2026-07-15T03:00:00.000Z';
const clock = () => new Date(FIXED_NOW);

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('gateway did not bind'));
      resolve({ port: address.port, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startVite(apiBaseUrl) {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api': { target: apiBaseUrl, changeOrigin: true, secure: false } },
    },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function waitForTraffic(traffic, predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = traffic.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for API traffic: ${JSON.stringify(traffic)}`);
}

async function captureEvidence(page, name) {
  const evidenceDir = String(process.env.EVIDENCE_DIR || '').trim();
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), animations: 'disabled' });
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, `horizontal overflow at ${await page.evaluate(() => window.innerWidth)}px`);
}

async function assertPhraseOnOneLine(page, selector, phrase) {
  const lineCount = await page.locator(selector).evaluate((element, target) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error('heading text node was not found');
    const start = text.textContent.replace(/\u00a0/g, ' ').indexOf(target);
    if (start < 0) throw new Error(`phrase was not found: ${target}`);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + target.length);
    return range.getClientRects().length;
  }, phrase);
  assert.equal(lineCount, 1, `${phrase} wrapped across ${lineCount} lines`);
}

function waitForSignal(signal, label, timeoutMs = 5_000) {
  return Promise.race([
    signal,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)),
  ]);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-work-gateway-e2e-'));
  let store = new HermesStore({ dataDir, clock });
  let notifyMessageStreamStarted = null;
  let releaseMessageStream = null;
  let pauseNextLiveResponse = false;
  let businessConsultantStopped = false;
  const resolveAgentAvailability = ({ mission }) => (
    businessConsultantStopped && mission?.agentId === 'bizconsultant'
      ? {
        available: false,
        code: 'agent_unavailable',
        status: 'stopped',
        message: '담당 에이전트가 현재 준비되지 않아 응답을 시작하지 않았습니다. 준비된 뒤 다시 시도해 주세요.',
      }
      : { available: true }
  );
  const liveTurnCompletion = async ({ onEvent }) => {
    await onEvent({ kind: 'progress', text: '실제 gateway가 작업 응답을 준비하고 있습니다.' });
    await onEvent({ kind: 'agent_message', text: '실시간 작업 ' });
    if (pauseNextLiveResponse) {
      pauseNextLiveResponse = false;
      notifyMessageStreamStarted?.();
      await new Promise((resolve) => { releaseMessageStream = resolve; });
    }
    await onEvent({ kind: 'agent_message', text: '응답입니다.' });
    return { text: '실시간 작업 응답입니다.', jobId: 'gateway-live-turn', executionEngine: 'hermes' };
  };
  let service = new AgentOperationsService({ store, clock, liveTurnCompletion, resolveAgentAvailability });
  const seeded = await service.createWork({
    clientRequestId: 'gateway-e2e-seed', templateId: 'general-agent-work', title: '실제 게이트웨이 승인 작업',
    objective: '실제 상태 전이를 검증한다.', initialMessage: '승인 대기 작업을 만들어줘.', executionEngine: 'auto',
    deliverable: { kind: 'report', format: 'markdown' },
  });
  const seededTask = store.createTask({
    id: 'task-gateway-e2e-approval', title: '실제 승인 상태 전이', owner: 'Agent', status: 'proposed',
    missionId: seeded.work.id, sessionId: 'session-gateway-e2e', origin: 'agent', agent: seeded.work.agentId,
    reason: '실제 파일 저장소 상태 전이 검증', expectedOutput: '승인된 작업', actionClass: 'research',
    executionEngine: 'auto', deliverable: { kind: 'report', format: 'markdown' },
  });
  store.createAgentSession({ id: seededTask.sessionId, missionId: seeded.work.id, taskId: seededTask.id, type: 'task', status: 'proposed' });

  let gateway = createRailwayGatewayServer({ env: {}, gatewayStore: store, agentOperationsService: service, agentOperationsClock: clock });
  const gatewayAddress = await listen(gateway);
  const vite = await startVite(gatewayAddress.baseUrl);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const traffic = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) traffic.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  });

  try {
    await page.goto(vite.url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();

    await page.locator(`[data-work-mission="${seeded.work.id}"]`).first().click();
    const seededCard = page.locator('.agent-work-task').filter({ hasText: seededTask.title });
    const approveResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/agent-operations/tasks/${seededTask.id}/approve`));
    await seededCard.getByRole('button', { name: '승인', exact: true }).click();
    assert.equal((await approveResponse).status(), 200);
    await page.locator('.agent-work-action-status', { hasText: '승인 처리가 완료됐습니다.' }).waitFor();
    assert.equal(store.getState().tasks.find((task) => task.id === seededTask.id)?.status, 'scheduled');

    businessConsultantStopped = true;
    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    await page.getByText('고급 설정', { exact: true }).click();
    await page.getByLabel('담당 에이전트').selectOption('bizconsultant');
    const stoppedObjective = '중지된 비즈니스 컨설턴트는 응답을 시작하면 안 됩니다';
    const stoppedCreateResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agent-operations/work');
    const stoppedResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/live'));
    await page.getByLabel('에이전트에게 작업 지시').fill(stoppedObjective);
    await page.getByRole('button', { name: '위임' }).click();
    const stoppedCreateResponse = await stoppedCreateResponsePromise;
    const stoppedCreatedBody = await stoppedCreateResponse.json();
    const stoppedWorkId = stoppedCreatedBody.work.id;
    const stoppedResponse = await stoppedResponsePromise;
    assert.match(stoppedResponse.url(), new RegExp(`/work/${stoppedWorkId}/live$`));
    assert.equal(stoppedResponse.status(), 200);
    assert.match(stoppedResponse.headers()['content-type'] || '', /text\/event-stream/);
    await page.locator('.agent-checkpoint[data-kind="error"]', { hasText: '응답을 시작하지 않았습니다.' }).waitFor();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.agent-work-live-turn').count(), 0);
    assert.equal(await page.getByLabel('작업 대화 메시지').isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: '작업 대화에 보내기' }).textContent(), '보내기');
    await captureEvidence(page, '1280-stopped');
    assert.equal(store.getState().agentSessionEvents.filter((event) => event.sessionId === stoppedCreatedBody.conversation.id && event.kind === 'error').length, 1);
    businessConsultantStopped = false;

    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    const createStart = traffic.length;
    const objective = '실제 게이트웨이로 시장 조사 문서를 만들어줘';
    await page.getByLabel('에이전트에게 작업 지시').fill(objective);
    const createResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agent-operations/work');
    await page.getByRole('button', { name: '위임' }).click();
    const createResponse = await createResponsePromise;
    const createdBody = await createResponse.json();
    assert.equal(createResponse.status(), 201);
    assert.ok(createdBody.work.id);
    assert.equal(createdBody.conversation.missionId, createdBody.work.id);
    await page.locator('.agent-work-header h1', { hasText: objective }).waitFor();
    await waitForTraffic(traffic, (item) => item.method === 'POST' && item.path.endsWith(`/work/${createdBody.work.id}/live`));
    await page.getByText('실시간 작업 응답입니다.', { exact: true }).waitFor();
    await waitForTraffic(traffic, (item) => item.method === 'GET' && item.path.endsWith(`/work/${createdBody.work.id}/conversation`));
    const createTraffic = traffic.slice(createStart);
    const createPost = createTraffic.findIndex((item) => item.method === 'POST' && item.path === '/api/agent-operations/work');
    const createAggregate = createTraffic.findIndex((item) => item.method === 'GET' && item.path === '/api/agent-operations');
    const createConversation = createTraffic.findIndex((item) => item.method === 'GET' && item.path.endsWith(`/work/${createdBody.work.id}/conversation`));
    assert.equal(createPost >= 0 && createAggregate > createPost && createConversation > createAggregate, true, JSON.stringify(createTraffic));

    const composer = page.getByLabel('작업 대화 메시지');
    const messageStart = traffic.length;
    await composer.fill('공식 출처를 우선해서 정리해줘');
    const messageResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/work/${createdBody.work.id}/live`));
    const messageStreamStarted = new Promise((resolve) => { notifyMessageStreamStarted = resolve; });
    pauseNextLiveResponse = true;
    await composer.press('Enter');
    await waitForSignal(messageStreamStarted, 'the real SSE delta');
    await page.locator('.agent-work-live-turn', { hasText: '실시간 작업' }).waitFor();
    assert.equal(await page.locator('.agent-work-live-turn').evaluate((element) => getComputedStyle(element).borderLeftWidth), '3px');
    assert.equal(await page.getByRole('button', { name: '작업 대화에 보내기' }).textContent(), '응답 중');
    assert.equal(await page.getByRole('button', { name: '작업 대화에 보내기' }).isDisabled(), true);
    await captureEvidence(page, '1280-streaming');
    releaseMessageStream?.();
    const messageResponse = await messageResponsePromise;
    assert.equal(messageResponse.status(), 200);
    assert.match(messageResponse.headers()['content-type'] || '', /text\/event-stream/);
    await page.getByText('공식 출처를 우선해서 정리해줘', { exact: true }).waitFor();
    await page.getByText('실시간 작업 응답입니다.', { exact: true }).last().waitFor();
    const timelineText = (await page.locator('.agent-checkpoint').allTextContents()).map((text) => text.replace(/\u00a0/g, ' '));
    const userMessageIndex = timelineText.findIndex((text) => text.includes('공식 출처를 우선해서 정리해줘'));
    const finalAnswerIndex = timelineText.map((text, index) => ({ text, index }))
      .filter((item) => item.text.includes('실시간 작업 응답입니다.')).at(-1)?.index;
    assert.ok(userMessageIndex >= 0 && finalAnswerIndex !== undefined);
    assert.equal(userMessageIndex < finalAnswerIndex, true, timelineText.join('\n'));
    await captureEvidence(page, '1280-settled');
    const messageTraffic = traffic.slice(messageStart);
    const messagePost = messageTraffic.findIndex((item) => item.method === 'POST' && item.path.endsWith('/live'));
    const messageRefreshTraffic = messageTraffic.slice(messagePost + 1);
    const messageAggregate = messageRefreshTraffic.findIndex((item) => item.method === 'GET' && item.path === '/api/agent-operations');
    const messageConversation = messageRefreshTraffic.findIndex((item, index) => index > messageAggregate && item.method === 'GET' && item.path.endsWith(`/work/${createdBody.work.id}/conversation`));
    assert.equal(messagePost >= 0 && messageAggregate >= 0 && messageConversation > messageAggregate, true, JSON.stringify(messageTraffic));

    await page.waitForFunction(() => {
      const sendButton = document.querySelector('.agent-work-composer button');
      return sendButton instanceof HTMLButtonElement && !sendButton.disabled;
    });
    await composer.fill('이 보고서를 고객에게 이메일로 보내줘');
    const rejectedResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/work/${createdBody.work.id}/live`));
    await composer.press('Enter');
    const rejectedResponse = await rejectedResponsePromise;
    assert.equal(rejectedResponse.status(), 200);
    assert.match(rejectedResponse.headers()['content-type'] || '', /text\/event-stream/);
    const blocked = page.locator('.agent-checkpoint[data-kind="blocked"]').filter({ hasText: '지원되지' }).last();
    await blocked.waitFor();
    assert.equal(await blocked.getByRole('button').count(), 0);
    assert.equal(await page.locator('.agent-checkpoint-approval').filter({ has: blocked }).count(), 0);

    const statePath = path.join(dataDir, 'state.json');
    assert.equal(fs.existsSync(statePath), true);
    const persistedBeforeRestart = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persistedBeforeRestart.agentMissions.some((mission) => mission.id === createdBody.work.id), true);
    const persistedUserMessage = persistedBeforeRestart.agentSessionEvents.find((event) => event.kind === 'user_message' && event.text === '공식 출처를 우선해서 정리해줘');
    assert.ok(persistedUserMessage?.id);
    assert.equal(persistedBeforeRestart.agentSessionEvents.some((event) => event.kind === 'agent_message' && event.text === '실시간 작업 응답입니다.'), true);

    await close(gateway);
    store = new HermesStore({ dataDir, clock });
    service = new AgentOperationsService({ store, clock, liveTurnCompletion, resolveAgentAvailability });
    gateway = createRailwayGatewayServer({ env: {}, gatewayStore: store, agentOperationsService: service, agentOperationsClock: clock });
    await listen(gateway, gatewayAddress.port);
    await page.reload();
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await page.locator('.agent-recent-work-card', { hasText: createdBody.work.title }).click();
    await page.getByText('공식 출처를 우선해서 정리해줘', { exact: true }).waitFor();
    await page.getByText('이 보고서를 고객에게 이메일로 보내줘', { exact: true }).waitFor();
    assert.equal(store.getState().tasks.find((task) => task.id === seededTask.id)?.status, 'scheduled');
    await page.setViewportSize({ width: 768, height: 900 });
    await assertNoHorizontalOverflow(page);
    await captureEvidence(page, '768-settled');
    await page.setViewportSize({ width: 375, height: 812 });
    await assertNoHorizontalOverflow(page);
    await assertPhraseOnOneLine(page, '.agent-work-header h1', '시장 조사');
    const mobileScrollOwners = await page.locator('.agent-work-conversation, .agent-work-layout, .agent-work-primary, .agent-work-timeline, .agent-work-details').evaluateAll((elements) => elements.filter((element) => {
      const overflowY = getComputedStyle(element).overflowY;
      return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight;
    }).map((element) => element.className));
    assert.deepEqual(mobileScrollOwners, ['agent-work-timeline']);
    await captureEvidence(page, '375-settled');
    await page.locator('.agent-work-composer').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.agent-work-composer').evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight), true);
    await page.locator('.agent-work-timeline').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.locator('.agent-checkpoint[data-kind="blocked"]').last().waitFor();
    assert.equal(await page.locator('.agent-checkpoint-delivery-outcome').evaluateAll((elements) => elements.every((element) => getComputedStyle(element).whiteSpace === 'nowrap')), true);
    assert.equal(await page.locator('.agent-checkpoint-delivery-outcome').evaluateAll((elements) => elements.every((element) => getComputedStyle(element.parentElement).display === 'grid')), true);
    assert.equal(await page.locator('.agent-checkpoint-delivery-outcome').evaluateAll((elements) => elements.every((element) => !/^—/.test(element.textContent || ''))), true);
    await captureEvidence(page, '375-timeline-bottom');
    await page.setViewportSize({ width: 640, height: 450 });
    await assertNoHorizontalOverflow(page);
    await page.locator('.agent-work-composer').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.agent-work-composer').evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight), true);
    await captureEvidence(page, '640-effective-200zoom');
    assert.equal(traffic.every((item) => item.status >= 200 && item.status < 400), true, JSON.stringify(traffic.filter((item) => item.status >= 400)));
    console.log(JSON.stringify({ ok: true, createdWorkId: createdBody.work.id, messageId: persistedUserMessage.id, persisted: true, apiResponses: traffic.length }, null, 2));
  } finally {
    await browser.close();
    await vite.server.close();
    if (gateway.listening) await close(gateway);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
