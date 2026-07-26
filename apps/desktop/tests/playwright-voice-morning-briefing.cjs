const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.addInitScript(() => {
    window.__spokenTexts = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      cancel() {},
      speak(utterance) { window.__spokenTexts.push(utterance.text); },
      getVoices() { return []; },
    } });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class {
      constructor(text) {
        this.text = text;
        this.lang = '';
        this.rate = 1;
      }
    } });
    const MockSpeechRecognition = class {
      start() {
        this.onstart?.();
        this.onresult?.({ results: [[{ transcript: '내일 일정 알려줘' }]] });
        this.onend?.();
      }
      stop() { this.onend?.(); }
    };
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: MockSpeechRecognition });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: MockSpeechRecognition });
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method: request.method(), path: url.pathname, body });
    if (request.method() === 'POST' && url.pathname === '/api/chat/stream') {
      const answer = String(body.message).includes('아침 브리핑')
        ? '좋은 아침입니다. 오늘 첫 일정은 오전 10시 회의입니다.'
        : '내일 일정은 오후 2시 검토 회의입니다.';
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: `event: delta\ndata: ${JSON.stringify({ text: answer })}\n\nevent: done\ndata: ${JSON.stringify({ text: answer })}\n\n`,
      });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [],
        runs: [],
        documents: [],
        messages: [],
        chatMessages: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
      },
    });
  });

  await page.goto(target);
  await page.getByRole('button', { name: '캘린더 AI 열기' }).click();
  await page.getByRole('button', { name: '아침 브리핑 시작' }).click();
  await page.waitForFunction(() => window.__spokenTexts?.some((text) => text.includes('좋은 아침입니다')));

  await page.getByRole('button', { name: '음성으로 질문' }).click();
  await page.getByText('내일 일정은 오후 2시 검토 회의입니다.').waitFor();
  await page.waitForTimeout(100);

  const streamCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream');
  const spokenTexts = await page.evaluate(() => window.__spokenTexts || []);
  assert.equal(streamCalls.length, 2);
  assert.match(streamCalls[0].body.message, /아침 브리핑/);
  assert.equal(streamCalls[1].body.message, '내일 일정 알려줘');
  assert.equal(spokenTexts.filter((text) => text.includes('좋은 아침입니다')).length, 1);
  assert.equal(spokenTexts.filter((text) => text.includes('내일 일정은')).length, 1);
  assert.equal(await page.getByText('답변을 음성으로 읽고 있어요.').isVisible(), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, streamCalls }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
