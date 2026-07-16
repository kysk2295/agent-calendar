const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const evidenceDir = process.env.EVIDENCE_DIR || '';

const state = {
  tasks: [
    { id: 'mobile-task-1', title: '모바일 핵심 동선 검증', owner: 'Me', status: 'Planned', date: '2026-07-16', category: '기본함', project: '기본함', notes: '상세 패널도 모바일에서 읽을 수 있어야 합니다.' },
    { id: 'mobile-task-2', title: '에이전트 위임 결과 확인', owner: 'Agent', status: 'Doing', date: '2026-07-17', category: '업무', project: 'Agent Calendar' },
    { id: 'mobile-task-3', title: '완료된 회귀 테스트', owner: 'Me', status: 'Done', date: '2026-07-15', category: '기본함', project: '기본함', done: true },
  ],
  events: [{ id: 'mobile-event', title: '모바일 QA', date: '2026-07-16', time: '14:00', source: 'calendar-event' }],
  inbox: [{ id: 'mobile-mail', from: 'qa@example.test', subject: '모바일 메일 상세 확인', preview: '목록과 상세가 모두 사용 가능해야 합니다.', body: '모바일 화면에서 작업 추가와 위임 버튼을 확인합니다.', unread: true }],
  documents: [
    { id: 'wiki-mobile', path: '2_wiki/mobile.md', title: '모바일 운영 원칙', excerpt: '핵심 화면은 작은 화면에서도 접근 가능해야 합니다.', body: '모바일 운영 원칙 본문' },
    { id: 'diary-mobile', path: '4_journal/2026-07-15.md', title: '어제의 일기', kind: 'diary', date: '2026-07-15', body: '😊 모바일 QA를 진행했다.' },
  ],
};

async function installApiFixtures(page) {
  const documents = state.documents.map((document) => ({ ...document }));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'POST' && path === '/api/chat/stream') {
      const requestBody = request.postDataJSON();
      const answer = requestBody.view === 'wiki'
        ? '모바일에서도 위키 근거를 바탕으로 자연스럽게 답했습니다.'
        : '모바일 콘솔 응답';
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: [
          `event: delta\ndata: ${JSON.stringify({ text: answer, source: 'railway-relay', gatewayFallback: false })}`,
          `event: done\ndata: ${JSON.stringify({ text: answer, source: 'railway-relay', gatewayFallback: false })}`,
          '',
        ].join('\n\n'),
      });
      return;
    }
    if (request.method() === 'POST' && path === '/api/wiki/search') {
      await route.fulfill({
        json: {
          ok: true,
          results: [{
            id: 'wiki-mobile',
            path: '2_wiki/mobile.md',
            title: '모바일 운영 원칙',
            excerpt: '핵심 화면은 작은 화면에서도 접근 가능해야 합니다.',
          }],
          answerMode: 'retrieval-only',
        },
      });
      return;
    }
    if (request.method() === 'POST' && path === '/api/documents') {
      const requestBody = request.postDataJSON();
      const document = {
        ...requestBody,
        id: `diary-created-${documents.length + 1}`,
        path: `4_journal/mobile-${documents.length + 1}.md`,
      };
      documents.push(document);
      await route.fulfill({ json: { ok: true, document } });
      return;
    }
    if (request.method() === 'POST' && path.startsWith('/api/inbox/commands/')) {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
        events: state.events,
        agents: [{ id: 'default', name: 'default', displayName: 'default', status: 'ready' }],
        runs: [],
        documents,
        notes: documents,
        tree: [{ id: 'wiki-mobile', path: '2_wiki/mobile.md', title: '모바일 운영 원칙' }],
        graph: { nodes: [{ id: 'wiki-mobile', path: '2_wiki/mobile.md', title: '모바일 운영 원칙' }], edges: [] },
        items: state.inbox,
        commands: state.inbox,
        jobs: [],
        messages: [],
        channels: [],
        tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });
}

async function openFromMobileMenu(page, label, selector) {
  await page.getByRole('button', { name: '전체 화면 메뉴 열기' }).click();
  const sheet = page.locator('.mobile-nav-sheet');
  await sheet.waitFor();
  await sheet.locator('button', { hasText: label }).first().click();
  await page.waitForFunction((title) => document.querySelector('.screen-heading strong')?.textContent?.trim() === title, label);
  if (selector) await page.locator(selector).waitFor();
  assert.equal(await sheet.isVisible(), false);
}

async function assertContained(page, selector, minimumWidth) {
  const metrics = await page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: rect.width,
      left: rect.left,
      right: rect.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      display: style.display,
      visibility: style.visibility,
    };
  });
  const viewportWidth = page.viewportSize().width;
  assert.ok(metrics.width >= minimumWidth, `${selector} width ${metrics.width}`);
  assert.ok(metrics.left >= -1, `${selector} starts outside viewport`);
  assert.ok(metrics.right <= viewportWidth + 1, `${selector} ends outside viewport`);
  assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${selector} has unintended horizontal overflow`);
  assert.notEqual(metrics.display, 'none');
  assert.notEqual(metrics.visibility, 'hidden');
}

async function assertKoreanWrapPolicy(page, selector) {
  const styles = await page.locator(selector).first().evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      wordBreak: computed.wordBreak,
      overflowWrap: computed.overflowWrap,
    };
  });
  assert.equal(styles.wordBreak, 'keep-all', `${selector} must keep Korean words together`);
  assert.equal(styles.overflowWrap, 'anywhere', `${selector} must retain a long-token fallback`);
}

async function captureEvidence(page, name) {
  if (!evidenceDir) return;
  await fs.mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, `${name}.png`),
    fullPage: false,
  });
}

async function verifyViewport(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 812 } });
  await installApiFixtures(page);
  await page.goto(target);
  await page.locator('.mobile-navigation').waitFor();
  await assertContained(page, '.mobile-navigation', width - 2);
  const [consoleButtonBox, contentBox] = await Promise.all([
    page.locator('.chat-fab').boundingBox(),
    page.locator('.content').boundingBox(),
  ]);
  assert.ok(consoleButtonBox && contentBox, 'mobile Console button and content must be visible');
  assert.ok(
    consoleButtonBox.y + consoleButtonBox.height <= contentBox.y + 1,
    `mobile Console button overlaps screen content: ${JSON.stringify({ consoleButtonBox, contentBox })}`,
  );

  const screens = [
    ['캘린더', '.calendar'],
    ['오늘', '.plan-screen'],
    ['다음 7일', '.task-list-screen'],
    ['기본함', '.task-list-screen'],
    ['메일함', '.mail'],
    ['칸반 보드', '.kanban'],
    ['주간 회고', '.review-screen'],
    ['위키', '.wiki'],
    ['일기', '.diary-screen'],
    ['에이전트', '.agent-operations-workspace'],
    ['위젯', '.widgets-showcase'],
  ];
  for (const [label, selector] of screens) {
    await openFromMobileMenu(page, label, selector);
    await captureEvidence(page, `${width}-${label}`);
  }

  await openFromMobileMenu(page, '주간 회고', '.review-screen');
  await assertKoreanWrapPolicy(page, '.review-screen');
  const reviewColumns = await page.locator('.review-kpis').evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean).length
  ));
  assert.equal(reviewColumns, width === 320 ? 2 : 4);
  const reviewValuesStayTogether = await page.locator('.review-kpis strong').evaluateAll((elements) => (
    elements.every((element) => getComputedStyle(element).whiteSpace === 'nowrap')
  ));
  assert.equal(reviewValuesStayTogether, true);

  await openFromMobileMenu(page, '기본함', '.task-list-screen');
  await assertContained(page, '.task-list-screen', width - 22);
  await assertContained(page, '.task-list-main', width - 22);
  await assertContained(page, '.task-inspector', width - 22);
  await page.locator('.task-row', { hasText: '에이전트 위임 결과 확인' }).click();
  assert.equal(await page.locator('.task-inspector .inspector-title').inputValue(), '에이전트 위임 결과 확인');

  await openFromMobileMenu(page, '칸반 보드', '.kanban');
  await assertContained(page, '.kanban', width - 22);
  await assertContained(page, '.kanban-col', width - 30);

  await openFromMobileMenu(page, '메일함', '.mail');
  await assertContained(page, '.mail', width - 22);
  await assertContained(page, '.mail-list', width - 22);
  await assertContained(page, '.mail-reader', width - 22);
  await assertKoreanWrapPolicy(page, '.mail-body');
  const mailActionRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/inbox/commands/mobile-mail/task'
  ));
  await page.getByRole('button', { name: /작업으로 추가/ }).click();
  const mailAction = await mailActionRequest;
  assert.equal(mailAction.postDataJSON().message, '모바일 메일 상세 확인');

  await openFromMobileMenu(page, '위키', '.wiki');
  await assertContained(page, '.wiki', width - 22);
  await assertContained(page, '.wiki-graph-panel', width - 22);
  await assertContained(page, '.wiki-side', width - 22);
  const wikiSearchRequest = page.waitForRequest((request) => (
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/wiki/search'
  ));
  const wikiChatRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/chat/stream'
    && request.postDataJSON().view === 'wiki'
  ));
  await page.locator('.askbar input').fill('모바일 핵심 화면 원칙은?');
  await page.locator('.askbar').getByRole('button', { name: '질문' }).click();
  const [wikiSearch, wikiChat] = await Promise.all([wikiSearchRequest, wikiChatRequest]);
  assert.equal(wikiSearch.postDataJSON().question, '모바일 핵심 화면 원칙은?');
  assert.equal(wikiChat.postDataJSON().agent, 'wikicurator');
  await page.locator('.wiki-answer').waitFor();
  assert.match(await page.locator('.wiki-answer').innerText(), /위키 근거를 바탕으로 자연스럽게 답했습니다/);
  await assertKoreanWrapPolicy(page, '.wiki-answer p');
  const sparseGraphLabel = await page.locator('.wiki-svg-node text').first().boundingBox();
  const sparseGraphNode = await page.locator('.wiki-svg-node circle').first().boundingBox();
  assert.ok(sparseGraphLabel && sparseGraphLabel.width >= 42 && sparseGraphLabel.height >= 10, `sparse wiki label ${JSON.stringify(sparseGraphLabel)}`);
  assert.ok(sparseGraphNode && sparseGraphNode.width >= 10 && sparseGraphNode.height >= 10, `sparse wiki node ${JSON.stringify(sparseGraphNode)}`);
  await captureEvidence(page, `${width}-위키-실제질문응답`);

  await openFromMobileMenu(page, '일기', '.diary-screen');
  await assertContained(page, '.diary-screen', width - 22);
  await assertContained(page, '.diary-screen main', width - 22);
  await assertContained(page, '.diary-screen > aside', width - 22);
  await assertKoreanWrapPolicy(page, '.diary-card textarea');
  await page.locator('.diary-card textarea').fill('모바일에서 실제 저장 동작을 검증했다.');
  await page.locator('.diary-moods').getByRole('button', { name: '😊' }).click();
  const diarySaveRequest = page.waitForRequest((request) => (
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/documents'
  ));
  await page.getByRole('button', { name: '위키에 저장' }).click();
  const diarySave = await diarySaveRequest;
  const diaryBody = diarySave.postDataJSON();
  assert.equal(diaryBody.kind, 'diary');
  assert.equal(diaryBody.source, 'hermes-desktop-diary');
  assert.match(diaryBody.body, /😊 모바일에서 실제 저장 동작을 검증했다/);
  await page.waitForFunction(() => document.querySelector('.diary-card textarea')?.value === '');

  await page.getByRole('button', { name: 'Agent Calendar 콘솔 열기' }).click();
  await page.locator('.chat').waitFor();
  assert.equal(await page.locator('.chat-runs:visible').count(), 0);
  await assertContained(page, '.chat', width - 2);
  await assertContained(page, '.chat footer', width - 2);
  await assertContained(page, '.chat textarea', width - 100);
  const consoleRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/chat/stream'
    && request.postDataJSON().view === 'console'
  ));
  await page.locator('.chat textarea').fill('오늘 핵심 작업을 알려줘');
  await page.locator('.chat').getByRole('button', { name: '전송' }).click();
  const consoleChat = await consoleRequest;
  assert.equal(consoleChat.postDataJSON().agent, 'default');
  await page.locator('.message.assistant', { hasText: '모바일 콘솔 응답' }).waitFor();
  await captureEvidence(page, `${width}-기본콘솔-응답`);
  await page.getByRole('button', { name: 'Agent Calendar 콘솔 닫기' }).last().click();
  await page.locator('.chat').waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '전체 화면 메뉴 열기' }).click();
  await page.locator('.mobile-nav-sheet').locator('button', { hasText: '설정' }).click();
  await page.locator('.settings-overlay').waitFor();
  await assertContained(page, '.settings-overlay', width - 26);
  const settingsMetrics = await page.locator('.settings-overlay').evaluate((overlay) => {
    const accountAction = overlay.querySelector('.account-box button');
    const actionStyle = accountAction ? getComputedStyle(accountAction) : null;
    const themeLabels = [...overlay.querySelectorAll('.theme-grid b')];
    return {
      actionWidth: accountAction?.getBoundingClientRect().width || 0,
      actionWhiteSpace: actionStyle?.whiteSpace || '',
      themeLabelsFit: themeLabels.every((label) => label.scrollWidth <= label.clientWidth + 1),
    };
  });
  assert.ok(settingsMetrics.actionWidth >= 68, `settings account action width ${settingsMetrics.actionWidth}`);
  assert.equal(settingsMetrics.actionWhiteSpace, 'nowrap');
  assert.equal(settingsMetrics.themeLabelsFit, true);
  await assertKoreanWrapPolicy(page, '.theme-preview b');
  await captureEvidence(page, `${width}-설정`);
  await page.getByRole('button', { name: '완료' }).click();
  await page.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyViewport(browser, 320);
    await verifyViewport(browser, 375);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ ok: true, viewports: ['320x812', '375x812'] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
