const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('server did not bind'));
      resolve({ port: address.port, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function closeVite(vite) {
  vite.server.httpServer?.closeAllConnections?.();
  await vite.server.close();
}

async function reservePort() {
  const server = http.createServer();
  const { port } = await listen(server);
  await close(server);
  return port;
}

function configuredSettings() {
  const settingsPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Agent Calendar', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const apiBaseUrl = String(settings.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const apiToken = String(settings.apiToken || '').trim();
  if (!apiBaseUrl || !apiToken) throw new Error('Configured Agent Calendar API credentials are required for this real-runtime test.');
  return { apiBaseUrl, apiToken };
}

async function startVite(apiProxyBaseUrl, credential, port) {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiProxyBaseUrl,
          changeOrigin: true,
          secure: false,
          headers: { 'x-agent-calendar-proxy-credential': credential },
        },
      },
    },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function capture(page, name) {
  const evidenceDir = String(process.env.EVIDENCE_DIR || '').trim();
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), animations: 'disabled' });
}

async function waitForTraffic(traffic, predicate, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = traffic.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for configured-runtime API traffic: ${JSON.stringify(traffic)}`);
}

async function waitForSettledAgentMessage(page, previousCount) {
  const durableSelector = '.agent-checkpoint[data-kind="agent_message"]:not(.agent-work-live-turn)';
  await page.waitForFunction((input) => document.querySelectorAll(input.selector).length > input.count, { selector: durableSelector, count: previousCount }, { timeout: 120_000 });
  await page.waitForFunction(() => !document.querySelector('.agent-work-live-turn'), undefined, { timeout: 120_000 });
  const messages = await page.locator(`${durableSelector} p`).allTextContents();
  const text = messages.at(-1)?.trim() || '';
  assert.ok(text, 'configured runtime did not persist a final agent message');
  return text;
}

async function main() {
  const settings = configuredSettings();
  const agentId = String(process.env.AGENT_ID || 'default').trim() || 'default';
  const selectedExecutionEngine = String(process.env.EXECUTION_ENGINE || 'hermes').trim();
  assert.ok(['hermes', 'local_llm', 'codex'].includes(selectedExecutionEngine), `Unsupported configured-runtime engine: ${selectedExecutionEngine}`);
  const nonce = `AC-LIVE-${Date.now()}`;
  const consoleNonce = `AC-CONSOLE-${Date.now()}`;
  const vitePort = await reservePort();
  const credential = `configured-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { createApiProxyServer } = await import(pathToFileURL(path.resolve('apps/desktop/dist-electron/proxy.js')).href);
  const proxy = createApiProxyServer({
    allowedDevOrigin: `http://127.0.0.1:${vitePort}`,
    credential,
    getSettings: () => settings,
  });
  const proxyAddress = await listen(proxy);
  const vite = await startVite(proxyAddress.baseUrl, credential, vitePort);
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const apiResponses = [];
  const consoleErrors = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) {
      apiResponses.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
        contentType: response.headers()['content-type'] || '',
      });
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.__agentWorkLiveFrames = [];
    window.__consoleLiveFrames = [];
    const capture = () => {
      const live = document.querySelector('.agent-work-live-turn');
      if (live) window.__agentWorkLiveFrames.push({ text: live.textContent || '', at: Date.now() });
      const consoleAnswer = document.querySelector('.chat .message.assistant:last-of-type');
      if (consoleAnswer) window.__consoleLiveFrames.push({ text: consoleAnswer.textContent || '', at: Date.now() });
    };
    new MutationObserver(capture).observe(document, { childList: true, subtree: true, characterData: true });
  });

  try {
    await page.goto(vite.url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await page.getByText('고급 설정', { exact: true }).click();
    const responsibleAgent = page.getByLabel('담당 에이전트');
    await responsibleAgent.locator(`option[value="${agentId}"]`).waitFor({ state: 'attached', timeout: 60_000 });
    await responsibleAgent.selectOption(agentId);
    await page.getByLabel('실행 엔진').selectOption(selectedExecutionEngine);

    const objective = `실제 연결 검증입니다. 반드시 ${nonce}를 그대로 포함하고, 37 곱하기 19의 계산 결과를 한 문장으로 답하세요.`;
    const createResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agent-operations/work');
    await page.getByLabel('에이전트에게 작업 지시').fill(objective);
    const initialTurnStartedAt = Date.now();
    await page.getByRole('button', { name: '위임' }).click();

    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201);
    const created = await createResponse.json();
    const workId = String(created.work?.id || '');
    assert.ok(workId, 'configured runtime did not create delegated work');
    assert.equal(created.work?.agentId, agentId);
    assert.equal(created.work?.executionEngine, selectedExecutionEngine);
    const initialLiveResponse = await waitForTraffic(apiResponses, (item) => item.method === 'POST' && item.path.endsWith(`/work/${workId}/live`), 120_000);
    assert.equal(initialLiveResponse.status, 200);
    assert.match(initialLiveResponse.contentType, /text\/event-stream/);

    await page.locator('.agent-work-live-turn').waitFor({ timeout: 120_000 });
    await capture(page, '1280-configured-streaming');
    const initialAnswer = await waitForSettledAgentMessage(page, 0);
    const initialTurnSettledAt = Date.now();
    assert.match(initialAnswer, new RegExp(nonce));
    assert.match(initialAnswer, /703/);
    const persistedWorkStatus = await page.evaluate(async (id) => {
      const response = await fetch(`/api/agent-operations/work/${encodeURIComponent(id)}/conversation`);
      const body = await response.json();
      return body.work?.status || '';
    }, workId);
    assert.equal(persistedWorkStatus, 'active');
    assert.equal(await page.getByLabel('작업 대화 메시지').isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: '작업 대화에 보내기' }).textContent(), '보내기');
    const lifecycleLogs = await page.locator('.agent-checkpoint[data-kind="progress"] p').allTextContents();
    assert.equal(
      lifecycleLogs.some((text) => /(?:\[redacted-command\]|^(?:run created|agent=|model=|mission=|\d{2}:\d{2}:\d{2} (?:runner started|reading task context))$)/im.test(text.trim())),
      false,
      `raw relay lifecycle logs leaked into the Work Conversation: ${lifecycleLogs.join(' | ')}`,
    );
    assert.equal(
      await page.locator('.api-banner').count(),
      0,
      'an unrelated optional API failure covered the Work Conversation',
    );
    await capture(page, '1280-configured-settled');

    const beforeFollowUp = await page.locator('.agent-checkpoint[data-kind="agent_message"]:not(.agent-work-live-turn)').count();
    const followUpLiveResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/work/${workId}/live`));
    await page.getByLabel('작업 대화 메시지').fill('방금 답변을 한 문장으로 더 간결하게 다듬어 주세요.');
    await page.getByLabel('작업 대화 메시지').press('Enter');
    const followUpLiveResponse = await followUpLiveResponsePromise;
    assert.equal(followUpLiveResponse.status(), 200);
    assert.match(followUpLiveResponse.headers()['content-type'] || '', /text\/event-stream/);
    await page.locator('.agent-work-live-turn').waitFor({ timeout: 120_000 });
    const followUpAnswer = await waitForSettledAgentMessage(page, beforeFollowUp);

    const liveFrames = await page.evaluate(() => window.__agentWorkLiveFrames);
    assert.ok(liveFrames.some((frame) => frame.text.includes('응답 중')), 'the configured runtime never rendered a live response state');
    const firstAnswerFrame = liveFrames.find((frame) => frame.at >= initialTurnStartedAt && frame.text.includes('응답 중') && !frame.text.includes('응답을 받고 있습니다.'));
    assert.ok(firstAnswerFrame, 'the configured runtime never rendered a streamed answer delta');
    const progressiveAnswerFrames = [...new Map(liveFrames
      .filter((frame) => frame.at >= initialTurnStartedAt && frame.at <= initialTurnSettledAt && frame.text.includes('응답 중') && !frame.text.includes('응답을 받고 있습니다.'))
      .map((frame) => [frame.text, frame])).values()];
    assert.ok(progressiveAnswerFrames.length >= 2, `the configured runtime rendered only ${progressiveAnswerFrames.length} distinct answer frame(s)`);
    assert.ok(progressiveAnswerFrames.every((frame, index) => index === 0 || frame.text.length > progressiveAnswerFrames[index - 1].text.length), 'the configured runtime answer frames did not grow incrementally');
    assert.ok(apiResponses.some((item) => item.method === 'POST' && item.path.endsWith(`/work/${workId}/live`) && item.status === 200), 'the configured runtime did not use the live SSE endpoint');
    assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));

    await page.reload();
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    const restoredWork = page.locator(`.agent-recent-work-card[data-work-mission="${workId}"]`);
    try {
      await restoredWork.waitFor({ timeout: 30_000 });
      await restoredWork.click();
    } catch (error) {
      await capture(page, '1280-configured-home-missing-work');
      const aggregate = await page.evaluate(async (id) => {
        const response = await fetch('/api/agent-operations');
        const body = await response.json();
        return {
          status: response.status,
          containsWork: Array.isArray(body.missions) && body.missions.some((mission) => mission && mission.id === id),
          missionCount: Array.isArray(body.missions) ? body.missions.length : -1,
        };
      }, workId);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nReloaded aggregate: ${JSON.stringify(aggregate)}`);
    }
    try {
      await page.locator('.agent-checkpoint[data-kind="agent_message"]:not(.agent-work-live-turn) p').filter({ hasText: followUpAnswer }).last().waitFor({ timeout: 30_000 });
    } catch (error) {
      await capture(page, '1280-configured-reload-failure');
      const timeline = await page.locator('.agent-work-timeline').allTextContents();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nReloaded timeline: ${timeline.join(' | ')}`);
    }
    assert.equal(await page.locator('.agent-work-live-turn').count(), 0);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await capture(page, '375-configured-reloaded');

    let consoleAnswer = '';
    let consoleLiveFrames = [];
    if (selectedExecutionEngine === 'hermes') {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('.chat-fab').click();
      await page.locator('.chat').waitFor();
      const consoleStreamResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST' && url.pathname === '/api/chat/stream';
      });
      const consolePrompt = `실제 연결 검증입니다. 반드시 ${consoleNonce}를 그대로 포함하고, 29 곱하기 17의 결과를 한 문장으로 답하세요.`;
      await page.locator('.chat textarea').fill(consolePrompt);
      await page.locator('.chat textarea').press('Enter');
      const consoleStreamResponse = await consoleStreamResponsePromise;
      assert.equal(consoleStreamResponse.status(), 200);
      assert.match(consoleStreamResponse.headers()['content-type'] || '', /text\/event-stream/);
      await page.waitForFunction(
        (expected) => {
          const answer = document.querySelector('.chat .message.assistant:last-of-type');
          const content = answer?.textContent || '';
          return content.includes(expected.nonce) && content.includes(expected.answer);
        },
        { nonce: consoleNonce, answer: '493' },
        { timeout: 120_000 },
      );
      consoleAnswer = (await page.locator('.chat .message.assistant:last-of-type').textContent())?.trim() || '';
      assert.match(consoleAnswer, new RegExp(consoleNonce));
      assert.match(consoleAnswer, /493/);
      assert.equal(await page.locator('.chat textarea').inputValue(), '');
      consoleLiveFrames = await page.evaluate(() => window.__consoleLiveFrames);
      assert.ok(consoleLiveFrames.some((frame) => frame.text.includes('응답 수신 중')), 'the configured console never rendered a pending response state');
      assert.ok(consoleLiveFrames.some((frame) => frame.text.includes(consoleNonce)), 'the configured console never rendered the real streamed response');
      await capture(page, '1280-configured-console');
    }

    console.log(JSON.stringify({
      ok: true,
      workId,
      agentId,
      executionEngine: selectedExecutionEngine,
      persistedWorkStatus,
      firstDeltaMs: firstAnswerFrame.at - initialTurnStartedAt,
      firstAnswerChars: initialAnswer.length,
      progressiveAnswerFrames: progressiveAnswerFrames.length,
      followUpAnswerChars: followUpAnswer.length,
      consoleAnswerChars: consoleAnswer.length,
      consoleLiveFrames: consoleLiveFrames.length,
      liveFrames: liveFrames.length,
      apiResponses: apiResponses.length,
    }, null, 2));
  } finally {
    await browser.close();
    await closeVite(vite);
    if (proxy.listening) {
      proxy.closeAllConnections?.();
      await close(proxy);
    }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
