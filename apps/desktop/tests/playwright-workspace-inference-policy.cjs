const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const theme = process.env.AGENT_CALENDAR_E2E_THEME || 'default';
const outputDir = path.join(__dirname, '..', 'test-results', 'workspace-inference-policy');

async function main() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const saves = [];
  let failNextSave = false;
  let remotePolicy = { mode: 'runner', defaultEngine: 'claude' };

  await page.addInitScript(({ selectedTheme }) => {
    const authProfile = {
      provider: 'authkit',
      id: 'policy-qa-user',
      email: 'policy@example.test',
      name: 'Policy QA',
      updatedAt: '2026-07-25T00:00:00.000Z',
    };
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: '',
        hasApiToken: false,
        hasSession: true,
        theme: selectedTheme,
        authProfile,
        session: {
          signedIn: true,
          workspaceId: 'workspace-policy-qa',
          userId: 'policy-qa-user',
          role: 'owner',
        },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      }),
      getSessionStatus: async () => ({
        signedIn: true,
        sessionId: 'session-policy-qa',
        userId: 'policy-qa-user',
        workspaceId: 'workspace-policy-qa',
        role: 'owner',
        email: 'policy@example.test',
        displayName: 'Policy QA',
        accessExpiresAt: null,
      }),
      getHermesConnection: async () => ({ baseUrl: '', credential: '' }),
      getDesktopReleaseStatus: async () => ({
        supported: false,
        phase: 'unsupported',
        currentVersion: '0.1.0',
        availableVersion: null,
        progressPercent: null,
        checkedAt: null,
        message: '테스트 환경',
      }),
      consumeDesktopRecoveryStatus: async () => ({
        phase: 'none',
        crashCount: 0,
        reason: null,
        occurredAt: null,
        message: '',
      }),
      onDesktopReleaseStatus: () => () => {},
      onAuthSessionChanged: () => () => {},
      onAuthLoginError: () => () => {},
    };
  }, { selectedTheme: theme });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (url.pathname === '/api/settings' && request.method() === 'POST') {
      const body = request.postDataJSON();
      saves.push(body);
      if (failNextSave) {
        failNextSave = false;
        await route.fulfill({
          status: 503,
          json: { ok: false, error: 'SETTINGS_SAVE_FAILED', message: '저장 테스트 실패' },
        });
        return;
      }
      remotePolicy = body.inferencePolicy;
      await route.fulfill({
        json: {
          ok: true,
          onboarding: { version: 1, status: 'completed' },
          inferencePolicy: remotePolicy,
        },
      });
      return;
    }
    if (url.pathname === '/api/settings') {
      await route.fulfill({
        json: {
          ok: true,
          onboarding: { version: 1, status: 'completed' },
          inferencePolicy: remotePolicy,
          uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
        },
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
        notes: [],
        graph: { nodes: [], edges: [] },
        items: [],
        commands: [],
        jobs: [],
        messages: [],
        channels: [],
        tools: [],
        onboarding: { version: 1, status: 'completed' },
        settings: {
          onboarding: { version: 1, status: 'completed' },
          inferencePolicy: remotePolicy,
        },
      },
    });
  });

  try {
    await page.goto(target);
    await page.locator('.profile').click();
    await page.getByTestId('settings-nav-ai').click();
    await page.getByTestId('inference-policy-panel').waitFor();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="inference-default-engine"]')?.value === 'claude'
    ));

    assert.equal(await page.getByTestId('inference-mode-runner').getAttribute('data-active'), 'true');
    assert.equal(await page.getByTestId('inference-default-engine').inputValue(), 'claude');

    await page.getByTestId('inference-default-engine').selectOption('hermes');
    await page.getByTestId('inference-policy-save').click();
    await page.getByTestId('inference-policy-status').filter({ hasText: '저장됨' }).waitFor();
    assert.deepEqual(saves.at(-1), {
      inferencePolicy: { mode: 'runner', defaultEngine: 'hermes' },
    });
    assert.doesNotMatch(JSON.stringify(saves), /apiKey|token|cookie|credential/i);

    await page.getByTestId('inference-mode-cloud').click();
    assert.equal(await page.getByTestId('inference-policy-save').isDisabled(), true);
    await page.getByTestId('inference-cloud-confirm').check();
    await page.getByTestId('inference-policy-save').click();
    await page.getByTestId('inference-policy-status').filter({ hasText: '저장됨' }).waitFor();
    assert.deepEqual(saves.at(-1), {
      inferencePolicy: { mode: 'agent_calendar_cloud', defaultEngine: 'hermes' },
    });

    failNextSave = true;
    await page.getByTestId('inference-mode-runner').click();
    await page.getByTestId('inference-default-engine').selectOption('codex');
    await page.getByTestId('inference-policy-save').click();
    await page.getByTestId('inference-policy-status').filter({ hasText: '저장하지 못했습니다' }).waitFor();
    assert.equal(await page.getByTestId('inference-policy-applied').textContent(), 'Agent Calendar Cloud AI');

    await page.screenshot({
      path: path.join(outputDir, `${theme}-desktop.png`),
      fullPage: true,
    });

    await page.setViewportSize({ width: 720, height: 760 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0);
    await page.screenshot({
      path: path.join(outputDir, `${theme}-compact.png`),
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ ok: true, saves }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
