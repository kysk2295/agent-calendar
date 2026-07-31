'use strict';

/**
 * Electron E2E: WorkOS AuthKit Desktop login with injected fake backend only.
 * Never enables a production auth bypass.
 *
 * Hard requirements:
 * - completeCount === 1 after terminate/relaunch (true session restore; no re-login fallback)
 * - settings.json has no access/refresh/API/provider tokens
 * - app-session.enc is non-plaintext encrypted bytes
 * - hard timeout clears on success (no lingering 90s handle)
 * - deterministic single-process close before relaunch
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const desktopRoot = path.resolve(__dirname, '..');
const firstUserJourney = process.env.AGENT_CALENDAR_FIRST_USER_JOURNEY === '1';
const phase8SessionTruth = process.env.AGENT_CALENDAR_PHASE8_SESSION_TRUTH === '1';
const phase8GoogleOAuth = process.env.AGENT_CALENDAR_PHASE8_GOOGLE_OAUTH === '1' || firstUserJourney;
const phase8OfflineReconnect = process.env.AGENT_CALENDAR_PHASE8_OFFLINE_RECONNECT === '1';
const phase8DesktopRelease = process.env.AGENT_CALENDAR_PHASE8_DESKTOP_RELEASE === '1';
const orcaShellAudit = process.env.AGENT_CALENDAR_ORCA_SHELL_AUDIT === '1';
const e2eTheme = process.env.AGENT_CALENDAR_E2E_THEME === 'dark' ? 'dark' : 'default';
const firstRunGuide = phase8SessionTruth || phase8GoogleOAuth || firstUserJourney;
const artifactName = firstUserJourney
  ? `first-user-journey${e2eTheme === 'dark' ? '-dark' : ''}`
  : phase8OfflineReconnect
  ? `phase8-offline-reconnect${e2eTheme === 'dark' ? '-dark' : ''}`
  : phase8DesktopRelease
    ? `phase8-desktop-release${e2eTheme === 'dark' ? '-dark' : ''}`
  : orcaShellAudit
    ? `orca-shell-calendar${e2eTheme === 'dark' ? '-dark' : ''}`
  : phase8GoogleOAuth
  ? `phase8-google-calendar-oauth${e2eTheme === 'dark' ? '-dark' : ''}`
  : phase8SessionTruth
    ? `phase8-session-truth${e2eTheme === 'dark' ? '-dark' : ''}`
    : 'workos-authkit-login';
const artifactDir = path.join(
  desktopRoot,
  'test-results',
  artifactName,
);
const screenshotBeforePath = path.join(artifactDir, firstRunGuide ? '01-stale-profile-login.png' : 'login-before-auth.png');
const screenshotGuidePath = path.join(artifactDir, '02-first-run-guide.png');
const screenshotGuideCompactPath = path.join(artifactDir, '02b-first-run-guide-768.png');
const screenshotGoogleErrorPath = path.join(artifactDir, '03-google-config-error.png');
const screenshotGoogleSuccessPath = path.join(artifactDir, '04-google-synced-guide.png');
const screenshotAgentsPath = path.join(artifactDir, '07-agents-mode-ab.png');
const screenshotSetupCompletePath = path.join(artifactDir, '06-setup-complete-calendar.png');
const screenshotSettingsPath = path.join(artifactDir, '03-settings.png');
const screenshotSettingsCompactPath = path.join(artifactDir, '04-settings-768.png');
const screenshotWidgetsPath = path.join(artifactDir, '05-widgets.png');
const screenshotWidgetsCompactPath = path.join(artifactDir, '06-widgets-768.png');
const screenshotDetailModalPath = path.join(artifactDir, '07-detail-modal.png');
const screenshotDetailDatePopoverPath = path.join(artifactDir, '07b-detail-date-popover.png');
const screenshotCompletionToastPath = path.join(artifactDir, '08-completion-toast.png');
const screenshotAfterPath = path.join(
  artifactDir,
  orcaShellAudit
    ? '01-calendar.png'
    : phase8OfflineReconnect
    ? '01-online-calendar.png'
    : firstRunGuide
      ? '05-authenticated-calendar.png'
      : 'calendar-after-login.png',
);
const screenshotOfflinePath = path.join(artifactDir, '02-offline-retained.png');
const screenshotRecoveredPath = path.join(artifactDir, '03-reconnected-calendar.png');
const screenshotRestartPath = path.join(
  artifactDir,
  orcaShellAudit
    ? '02-restarted-calendar.png'
    : phase8OfflineReconnect
    ? '04-cold-start-offline.png'
    : firstRunGuide
      ? '06-restarted-calendar.png'
      : 'calendar-after-restart.png',
);
const screenshotColdRecoveredPath = path.join(artifactDir, '05-cold-start-recovered.png');
const screenshotReleasePath = path.join(artifactDir, '01-release-ready.png');
const screenshotRecoveryPath = path.join(artifactDir, '02-safe-recovery.png');
const userDataName = `Agent Calendar AuthKit E2E ${process.pid}`;
const userData = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
const sessionFile = path.join(userData, 'app-session.enc');
const workspaceSnapshotFile = path.join(userData, 'workspace-snapshot.enc');
const settingsFile = path.join(userData, 'settings.json');
const HARD_TIMEOUT_MS = Number(process.env.AGENT_CALENDAR_E2E_TIMEOUT_MS || 90_000);

function ensureCleanUserData(apiBaseUrl) {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify({
    apiBaseUrl,
    apiToken: '',
    theme: e2eTheme,
    auth: phase8SessionTruth ? {
      provider: 'authkit',
      id: 'stale_user',
      email: 'stale@example.com',
      name: 'Stale Profile',
      workspaceId: 'stale_workspace',
      role: 'owner',
      updatedAt: new Date().toISOString(),
    } : null,
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

function forceKillPid(pid) {
  if (!pidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function assertSettingsHaveNoSecrets() {
  assert.equal(fs.existsSync(settingsFile), true, 'settings.json must exist');
  const raw = fs.readFileSync(settingsFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.apiToken || '', '', 'settings.apiToken must be empty');
  assert.doesNotMatch(raw, /accessToken|refreshToken|idToken|"code"\s*:/);
  if (parsed.auth && typeof parsed.auth === 'object') {
    assert.equal(parsed.auth.accessToken, undefined);
    assert.equal(parsed.auth.refreshToken, undefined);
    assert.equal(parsed.auth.idToken, undefined);
    assert.equal(parsed.auth.code, undefined);
  }
}

function assertSecureSessionEncryptedOnDisk() {
  assert.equal(fs.existsSync(sessionFile), true, 'app-session.enc must exist after login');
  const buf = fs.readFileSync(sessionFile);
  assert.ok(buf.length > 32, `encrypted session too small: ${buf.length}`);
  const asUtf8 = buf.toString('utf8');
  assert.doesNotMatch(asUtf8, /access_e2e|refresh_e2e|accessToken|refreshToken|"userId"/);
  // Must not be plaintext JSON session.
  assert.equal(asUtf8.trimStart().startsWith('{'), false, 'session file must not be plaintext JSON');
}

function createFakeAuthBackend() {
  /** @type {Map<string, { state: string, codeVerifier: string, status: string }>} */
  const transactions = new Map();
  let completeCount = 0;
  let protectedRequestCount = 0;
  let calendarAuthorizeCount = 0;
  let calendarFinalizeCount = 0;
  let calendarSyncCount = 0;
  let googleSource = null;
  let googleState = '';
  let available = true;
  let reconnectSuccessfulRequests = 0;
  let workspaceSettings = {
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
    ...(firstRunGuide ? {} : {
      onboarding: {
        version: 1,
        status: 'completed',
        completedAt: '2026-07-25T00:00:00.000Z',
      },
    }),
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }

    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'POST' && url.pathname === '/api/phase1/auth/desktop/start') {
      const state = `state_${transactions.size + 1}_${Date.now()}`;
      const codeVerifier = `verifier_${transactions.size + 1}`;
      const transactionId = `dlogin_e2e_${transactions.size + 1}`;
      transactions.set(state, { state, codeVerifier, status: 'pending', transactionId });
      return send(200, {
        ok: true,
        authorizationUrl: `https://authkit.test/authorize?state=${encodeURIComponent(state)}`,
        state,
        codeVerifier,
        transactionId,
        redirectUri: 'agent-calendar://auth/callback',
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/phase1/auth/desktop/complete') {
      const tx = transactions.get(String(body.state || ''));
      if (!tx || tx.status !== 'pending') {
        return send(401, { ok: false, error: 'DESKTOP_LOGIN_REPLAY', message: 'unauthorized' });
      }
      if (String(body.codeVerifier || '') !== tx.codeVerifier) {
        return send(401, { ok: false, error: 'DESKTOP_LOGIN_VERIFIER_MISMATCH', message: 'unauthorized' });
      }
      if (!body.code) {
        return send(400, { ok: false, error: 'DESKTOP_LOGIN_CODE_REQUIRED', message: 'bad_request' });
      }
      tx.status = 'completed';
      completeCount += 1;
      return send(200, {
        ok: true,
        sessionId: `sess_e2e_${completeCount}`,
        userId: 'user_e2e',
        workspaceId: 'ws_e2e',
        role: 'owner',
        accessToken: `access_e2e_${completeCount}`,
        refreshToken: `refresh_e2e_${completeCount}`,
        accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        user: { id: 'user_e2e', email: 'e2e@example.com', displayName: 'E2E Operator' },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/phase1/auth/refresh') {
      return send(200, {
        ok: true,
        sessionId: 'sess_e2e_1',
        accessToken: 'access_e2e_refreshed',
        refreshToken: String(body.refreshToken || 'refresh_e2e_1'),
        accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        workspaceId: 'ws_e2e',
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/phase1/auth/logout') {
      return send(200, { ok: true });
    }

    if (phase8OfflineReconnect && !available && url.pathname.startsWith('/api/')) {
      return send(503, {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Railway is temporarily unavailable',
      });
    }

    if (url.pathname.startsWith('/api/')) {
      protectedRequestCount += 1;
      if (phase8OfflineReconnect) reconnectSuccessfulRequests += 1;
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return send(200, { ok: true, workspaceId: 'ws_e2e', ...workspaceSettings });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      workspaceSettings = {
        ...workspaceSettings,
        ...body,
        uiPreferences: {
          ...workspaceSettings.uiPreferences,
          ...(body.uiPreferences || {}),
        },
      };
      return send(200, { ok: true, workspaceId: 'ws_e2e', ...workspaceSettings });
    }

    if (req.method === 'GET' && url.pathname === '/api/runners') {
      return send(200, {
        ok: true,
        runners: firstUserJourney ? [{
          id: 'runner-first-user',
          status: 'active',
          connectionState: 'connected',
          lastTestOk: true,
          hostMetadata: { hostName: 'first-user-mac' },
          capabilities: {
            engines: {
              codex: { available: true, status: 'ready', authStatus: 'authenticated' },
              claude: { available: true, status: 'ready', authStatus: 'authenticated' },
            },
          },
        }] : [],
      });
    }

    if (req.method === 'GET' && (url.pathname === '/api/wiki' || url.pathname === '/api/knowledge/sources')) {
      return send(200, {
        ok: true,
        knowledgeV2: true,
        sources: firstUserJourney ? [{
          id: 'wiki-source-first-user',
          status: 'active',
          title: '개인 위키',
          label: '개인 위키',
        }] : [],
        notes: [],
        tree: [],
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/agent-operations') {
      return send(200, {
        ok: true,
        missions: [],
        tasks: [],
        sessions: [],
        reports: [],
        daemon: { running: true, lastRun: null, lastError: null, mode: 'runner_required' },
        runner: firstUserJourney ? {
          connected: true,
          status: 'ready',
        } : null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/agents') {
      return send(200, {
        ok: true,
        agents: firstUserJourney ? [{
          id: 'bizconsultant',
          displayName: '비즈니스 컨설턴트',
          status: 'active',
          enabled: true,
          model: '',
          role: '분석',
          provider: 'hermes',
          trustLevel: 'workspace',
          allowedTaskClasses: [],
        }] : [],
      });
    }

    if (phase8GoogleOAuth && url.pathname.startsWith('/api/calendar/')) {
      if (!/^Bearer access_e2e/.test(String(req.headers.authorization || ''))) {
        return send(401, { ok: false, error: 'AUTH_REQUIRED' });
      }
      if (req.method === 'GET' && url.pathname === '/api/calendar/sources') {
        return send(200, {
          ok: true,
          sources: [
            {
              id: 'source-internal-e2e',
              provider: 'internal',
              label: 'Agent Calendar',
              status: 'connected',
              lastSyncedAt: '',
            },
            ...(googleSource ? [googleSource] : []),
          ],
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/calendar/sources/google/authorize') {
        calendarAuthorizeCount += 1;
        if (calendarAuthorizeCount === 1) {
          return send(503, {
            ok: false,
            error: 'GOOGLE_OAUTH_NOT_CONFIGURED',
          });
        }
        googleState = `calendar_state_${calendarAuthorizeCount}`;
        return send(200, {
          ok: true,
          state: googleState,
          authorizationUrl: `https://accounts.google.test/o/oauth2/v2/auth?state=${googleState}`,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/calendar/sources/google/callback') {
        if (body.state !== googleState || body.code !== 'calendar-code-e2e') {
          return send(400, { ok: false, error: 'GOOGLE_OAUTH_STATE_MISMATCH' });
        }
        calendarFinalizeCount += 1;
        googleSource = {
          id: 'source-google-e2e',
          provider: 'google',
          label: 'Google Calendar',
          status: 'connected',
          lastSyncedAt: '',
        };
        return send(200, { ok: true, source: googleSource });
      }
      if (
        req.method === 'POST'
        && url.pathname === '/api/calendar/sources/source-google-e2e/sync'
      ) {
        calendarSyncCount += 1;
        googleSource = {
          ...googleSource,
          lastSyncedAt: '2026-07-25T03:00:00.000Z',
        };
        return send(200, { ok: true, synced: 2 });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return send(200, {
        ok: true,
        tasks: orcaShellAudit
          ? [{
              id: 'orca-design-proof-task',
              title: '프로덕션 디자인 검수',
              date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()),
              time: '10:00',
              status: 'Planned',
              owner: 'Me',
              category: '기본함',
              project: '기본함',
            }]
          : [],
        events: phase8OfflineReconnect
          ? [{
              id: 'reconnect-proof-event',
              title: 'Reconnect proof event',
              date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()),
              time: '10:00',
              kind: 'calendar-event',
              source: 'internal',
            }]
          : [],
        agents: [],
        runs: [],
        documents: [],
        notes: [],
        commands: [],
        jobs: [],
        messages: [],
        channels: [],
        tools: [],
        graph: { nodes: [], edges: [] },
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
        gateway: { ok: true },
      });
    }

    send(404, { ok: false, error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        getCompleteCount: () => completeCount,
        getProtectedRequestCount: () => protectedRequestCount,
        getWorkspaceSettings: () => workspaceSettings,
        getCalendarAuthorizeCount: () => calendarAuthorizeCount,
        getCalendarFinalizeCount: () => calendarFinalizeCount,
        getCalendarSyncCount: () => calendarSyncCount,
        getGoogleState: () => googleState,
        getGoogleSource: () => googleSource,
        setAvailable: (next) => {
          available = Boolean(next);
        },
        isAvailable: () => available,
        getReconnectSuccessfulRequests: () => reconnectSuccessfulRequests,
        getLastState: () => {
          const values = [...transactions.values()];
          return values[values.length - 1] || null;
        },
        close: () => new Promise((res, rej) => {
          server.close((error) => (error ? rej(error) : res()));
        }),
      });
    });
  });
}

async function launchApp({ apiBaseUrl }) {
  const mainJs = path.join(desktopRoot, 'dist-electron', 'main.js');
  assert.equal(fs.existsSync(mainJs), true, 'build electron first (dist-electron/main.js missing)');
  fs.mkdirSync(userData, { recursive: true });
  const previous = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    : {};
  fs.writeFileSync(settingsFile, `${JSON.stringify({
    apiBaseUrl,
    apiToken: '',
    theme: previous.theme || 'default',
    auth: previous.auth || null,
    uiPreferences: previous.uiPreferences || { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2)}\n`);

  const electronPath = require('electron');
  const app = await electron.launch({
    executablePath: typeof electronPath === 'string' ? electronPath : undefined,
    args: [mainJs],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENT_CALENDAR_USER_DATA_NAME: userDataName,
      AGENT_CALENDAR_E2E_AUTH: '1',
      AGENT_CALENDAR_E2E_RELEASE: phase8DesktopRelease ? '1' : '0',
      VITE_DEV_SERVER_URL: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  return app;
}

async function receiveAuthUrl(electronApp, url) {
  return electronApp.evaluate(async (_electron, callbackUrl) => {
    const bridge = globalThis.__agentCalendarE2E;
    if (!bridge) throw new Error('E2E bridge missing');
    return bridge.receiveAuthUrl(callbackUrl);
  }, url);
}

async function closeApp(electronApp) {
  if (!electronApp) return { pid: null, exited: true };
  let pid = null;
  try {
    pid = electronApp.process().pid;
  } catch {
    pid = null;
  }

  try {
    await electronApp.evaluate(async ({ app }) => {
      app.exit(0);
    }).catch(() => {});
  } catch {
    // ignore
  }

  try {
    await Promise.race([
      electronApp.close(),
      sleep(2_000),
    ]);
  } catch {
    // ignore
  }

  if (pid && pidAlive(pid)) forceKillPid(pid);
  const exited = pid ? await waitForPidExit(pid, 8_000) : true;
  if (!exited && pid) {
    forceKillPid(pid);
    await waitForPidExit(pid, 2_000);
  }
  await sleep(400);
  return { pid, exited: pid ? !pidAlive(pid) : true };
}

async function simulateRendererGoneAndWait(electronApp) {
  const decision = await electronApp.evaluate(() => {
    const bridge = globalThis.__agentCalendarE2E;
    if (!bridge?.simulateRendererGone) throw new Error('Renderer recovery E2E bridge missing');
    return bridge.simulateRendererGone();
  });
  await sleep(250);
  return { decision, page: electronApp.windows()[0] };
}

async function assertOrcaShellLayout(page, label) {
  await page.waitForSelector('[data-testid="unified-calendar"]', { timeout: 20_000 });
  const result = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const style = (selector) => {
      const element = document.querySelector(selector);
      return element instanceof HTMLElement ? getComputedStyle(element) : null;
    };
    const sidebar = rect('.sidebar');
    const topbar = rect('.topbar');
    const chat = rect('.chat-fab');
    const grid = rect('.month-grid');
    const source = rect('.unified-calendar-sources');
    const active = style('.nav-item[data-active="true"]');
    const chatStyle = style('.chat-fab');
    const navText = document.querySelector('.nav')?.textContent || '';
    const primaryLabels = [...document.querySelectorAll('.nav-primary .nav-item')]
      .map((element) => element.textContent?.trim() || '');
    const workspaceDisclosure = document.querySelector('.nav-more');
    const visibleWorkspaceItems = [...document.querySelectorAll('.nav-more .nav-item')]
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .length;
    const issues = [];
    if (!sidebar || Math.abs(sidebar.width - 220) > 1) issues.push(`sidebar width ${sidebar?.width}`);
    if (!topbar || Math.abs(topbar.height - 40) > 1) issues.push(`topbar height ${topbar?.height}`);
    if (!chat || !topbar || chat.top < topbar.top - 1 || chat.bottom > topbar.bottom + 1) issues.push('Calendar AI is outside top bar');
    if (!grid || grid.height < 560) issues.push(`calendar grid height ${grid?.height}`);
    if (!source || source.height > 54) issues.push(`calendar source row height ${source?.height}`);
    if (!active || active.boxShadow !== 'none') issues.push(`active nav shadow ${active?.boxShadow}`);
    if (!chatStyle || chatStyle.backgroundImage !== 'none') issues.push(`Calendar AI background ${chatStyle?.backgroundImage}`);
    if (!chatStyle || Number.parseFloat(chatStyle.borderRadius) > 8) issues.push(`Calendar AI radius ${chatStyle?.borderRadius}`);
    if (/🗓️|☀️|📆|📥|✉️|📊|📚|📔|🤖/.test(navText)) issues.push('emoji navigation remains visible');
    if (primaryLabels.join('|') !== '캘린더|에이전트|자동화') issues.push(`primary navigation ${primaryLabels.join('|')}`);
    if (workspaceDisclosure?.hasAttribute('open')) issues.push('workspace disclosure starts open');
    if (visibleWorkspaceItems !== 0) issues.push(`workspace items visible while closed ${visibleWorkspaceItems}`);
    if (document.documentElement.scrollWidth > window.innerWidth) issues.push('horizontal page overflow');
    return { issues, sidebar, topbar, chat, grid, source, primaryLabels, visibleWorkspaceItems };
  });
  assert.deepEqual(result.issues, [], `${label}: ${JSON.stringify(result)}`);

  await page.locator('.nav-more > summary').click();
  await page.waitForFunction(() => document.querySelector('.nav-more')?.hasAttribute('open'));
  const expanded = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.nav-more .nav-item')]
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .map((element) => element.textContent?.trim() || '');
    return {
      labels,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  for (const expected of ['오늘', '다음 7일', '기본함', '위키', 'Runner 설정', '위젯']) {
    assert.ok(expanded.labels.some((label) => label.startsWith(expected)), `${label}: missing expanded navigation ${expected}`);
  }
  assert.equal(expanded.overflow, false, `${label}: expanded navigation caused horizontal overflow`);
  await page.locator('.nav-more > summary').click();
  await page.waitForFunction(() => !document.querySelector('.nav-more')?.hasAttribute('open'));
  return result;
}

async function assertOrcaResponsiveLayout(page) {
  const original = page.viewportSize() || { width: 1320, height: 824 };
  const checks = [];
  for (const viewport of [
    { width: 768, height: 820 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(120);
    checks.push(await page.evaluate((expected) => {
      const visibleRects = [...document.querySelectorAll(
        '.topbar button, .calendar-toolbar button, .unified-calendar-sources button, .nav-item',
      )]
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40) || element.tagName,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
        });
      const outside = visibleRects.filter((rect) => rect.left < -1 || rect.right > expected.width + 1 || rect.top < -1 || rect.bottom > expected.height + 1);
      const chat = document.querySelector('.chat-fab')?.getBoundingClientRect();
      const topbar = document.querySelector('.topbar')?.getBoundingClientRect();
      return {
        viewport: expected,
        scrollWidth: document.documentElement.scrollWidth,
        outside,
        chatInsideTopbar: Boolean(chat && topbar && chat.top >= topbar.top - 1 && chat.bottom <= topbar.bottom + 1),
      };
    }, viewport));
  }
  await page.setViewportSize(original);
  await page.waitForTimeout(120);
  checks.forEach((check) => {
    assert.equal(check.scrollWidth <= check.viewport.width, true, `responsive horizontal overflow: ${JSON.stringify(check)}`);
    assert.deepEqual(check.outside, [], `responsive controls outside viewport: ${JSON.stringify(check)}`);
    assert.equal(check.chatInsideTopbar, true, `responsive Calendar AI outside top bar: ${JSON.stringify(check)}`);
  });
  return checks;
}

async function assertCalendarAiTopbarInteraction(page) {
  const trigger = page.getByRole('button', { name: '캘린더 AI 열기' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.locator('.chat').waitFor({ state: 'visible', timeout: 10_000 });
  const drawerClose = page.locator('.chat').getByRole('button', { name: '캘린더 AI 닫기' });
  await drawerClose.waitFor({ state: 'visible' });
  await drawerClose.click();
  await page.locator('.chat').waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByRole('button', { name: '캘린더 AI 열기' }).waitFor({ state: 'visible' });
}

async function runScenario(backend) {
  ensureCleanUserData(backend.baseUrl);

  let electronApp = await launchApp({ apiBaseUrl: backend.baseUrl });
  try {
    const page = await electronApp.firstWindow();
    await page.waitForSelector('[data-testid="login-authkit-continue"]', { timeout: 20_000 });
    if (phase8SessionTruth) {
      assert.equal(
        backend.getProtectedRequestCount(),
        0,
        'signed-out boot must not hydrate protected product routes',
      );
      const signedOutSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.equal(
        signedOutSettings.auth,
        null,
        'orphan public profile must be cleared when no encrypted session exists',
      );
    }
    await page.screenshot({ path: screenshotBeforePath, fullPage: true });
    assert.ok(fs.statSync(screenshotBeforePath).size > 5_000, 'login-before-auth screenshot missing/small');

    // Probe encryption availability in this real macOS Electron process.
    const cryptoProbe = await electronApp.evaluate(async ({ safeStorage, app }) => ({
      encryptionAvailable: Boolean(safeStorage?.isEncryptionAvailable?.()),
      userData: app.getPath('userData'),
    }));
    assert.equal(
      cryptoProbe.encryptionAvailable,
      true,
      `safeStorage must be available on real macOS Electron (userData=${cryptoProbe.userData})`,
    );
    assert.ok(
      String(cryptoProbe.userData).includes(userDataName),
      `unexpected userData path: ${cryptoProbe.userData}`,
    );

    await page.getByRole('button', { name: /AuthKit으로 계속하기|Google 또는 이메일로 계속하기/ }).click();
    await page.waitForTimeout(400);

    const pending = backend.getLastState();
    assert.ok(pending, 'start must create a pending transaction');

    try {
      await receiveAuthUrl(electronApp, 'agent-calendar://auth/callback?code=forged&state=not-a-real-state');
    } catch {
      // expected
    }
    assert.equal(backend.getCompleteCount(), 0, 'forged callback must not complete login');

    const goodUrl = `agent-calendar://auth/callback?code=code-e2e-1&state=${encodeURIComponent(pending.state)}`;
    await receiveAuthUrl(electronApp, goodUrl);

    await page.waitForFunction(() => {
      const loginBtn = Array.from(document.querySelectorAll('button'))
        .some((b) => /AuthKit으로 계속하기|Google 또는 이메일로 계속하기/.test(b.textContent || '') || b.getAttribute('data-testid') === 'login-authkit-continue');
      return !loginBtn;
    }, null, { timeout: 20_000 });
    await page.waitForTimeout(500);

    if (firstRunGuide) {
      await page.waitForSelector('[data-testid="onboarding-guide"]', { timeout: 20_000 });
      const guideText = await page.locator('[data-testid="onboarding-guide"]').innerText();
      assert.match(guideText, /캘린더 동기화/);
      assert.match(guideText, /Runner와 실행 엔진/);
      assert.match(guideText, /Wiki 지식 소스/);
      assert.match(guideText, /Calendar AI 확인/);
      await page.screenshot({ path: screenshotGuidePath, fullPage: true });
      assert.ok(fs.statSync(screenshotGuidePath).size > 10_000, 'first-run guide screenshot missing/small');
      const guideSurface = await page.locator('[data-testid="onboarding-guide"]').evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const contentRect = document.querySelector('.content')?.getBoundingClientRect();
        const railRect = element.querySelector('.onboarding-steps')?.getBoundingClientRect();
        const heading = element.querySelector('.onboarding-detail-copy h3');
        return {
          width: rect.width,
          height: rect.height,
          contentWidth: contentRect?.width || 0,
          contentHeight: contentRect?.height || 0,
          railWidth: railRect?.width || 0,
          headingSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
          boxShadow: style.boxShadow,
          horizontalOverflow: element.scrollWidth > element.clientWidth,
        };
      });
      assert.ok(
        Math.abs(guideSurface.width - guideSurface.contentWidth) <= 1,
        `first-run guide width ${guideSurface.width}/${guideSurface.contentWidth}`,
      );
      assert.ok(
        Math.abs(guideSurface.height - guideSurface.contentHeight) <= 1,
        `first-run guide height ${guideSurface.height}/${guideSurface.contentHeight}`,
      );
      assert.ok(Math.abs(guideSurface.railWidth - 220) <= 1, `first-run guide rail ${guideSurface.railWidth}`);
      assert.ok(Math.abs(guideSurface.headingSize - 16) <= 1, `first-run guide heading ${guideSurface.headingSize}`);
      assert.equal(guideSurface.boxShadow, 'none', 'first-run guide must not use decorative elevation');
      assert.equal(guideSurface.horizontalOverflow, false, 'first-run guide must not overflow horizontally');
      const guideViewport = page.viewportSize();
      await page.setViewportSize({ width: 768, height: 820 });
      await page.waitForTimeout(100);
      await page.screenshot({ path: screenshotGuideCompactPath, fullPage: true });
      assert.ok(fs.statSync(screenshotGuideCompactPath).size > 10_000, 'compact first-run guide screenshot missing/small');
      if (guideViewport) await page.setViewportSize(guideViewport);

      if (phase8GoogleOAuth) {
        const connect = page.getByRole('button', { name: 'Google Calendar 연결', exact: true });
        await connect.click();
        await page.getByText('Google Calendar 연결을 사용할 수 없습니다. 관리자 설정을 확인하세요.').waitFor({
          state: 'visible',
          timeout: 10_000,
        });
        assert.equal(backend.getCalendarAuthorizeCount(), 1);
        assert.equal(backend.getCalendarFinalizeCount(), 0);
        await page.screenshot({ path: screenshotGoogleErrorPath, fullPage: true });
        assert.ok(fs.statSync(screenshotGoogleErrorPath).size > 10_000, 'Google config error screenshot missing/small');

        await connect.click();
        await page.waitForTimeout(200);
        const googleState = backend.getGoogleState();
        assert.ok(googleState, 'retry must issue a Google OAuth state');
        try {
          await receiveAuthUrl(
            electronApp,
            'agent-calendar://calendar/google/callback?code=forged&state=not-a-real-calendar-state',
          );
        } catch {}
        assert.equal(backend.getCalendarFinalizeCount(), 0, 'forged Google callback must not finalize');

        await receiveAuthUrl(
          electronApp,
          `agent-calendar://calendar/google/callback?code=calendar-code-e2e&state=${encodeURIComponent(googleState)}`,
        );
        await page.getByText('Google Calendar 동기화가 완료되었습니다.').waitFor({
          state: 'visible',
          timeout: 20_000,
        });
        await page.getByRole('button', { name: /캘린더 동기화 준비됨/ }).waitFor({
          state: 'visible',
          timeout: 20_000,
        });
        assert.equal(backend.getCalendarFinalizeCount(), 1);
        assert.equal(backend.getCalendarSyncCount(), 1);
        assert.ok(backend.getGoogleSource()?.lastSyncedAt, 'Google source must persist synchronized truth');
        await page.screenshot({ path: screenshotGoogleSuccessPath, fullPage: true });
        assert.ok(fs.statSync(screenshotGoogleSuccessPath).size > 10_000, 'Google sync screenshot missing/small');
      }

      if (firstUserJourney) {
        // Ready steps show "준비됨" in the rail (not the long statusLabel).
        const guide = page.locator('[data-testid="onboarding-guide"]');
        await page.getByRole('button', { name: /Runner와 실행 엔진/ }).click();
        await guide.locator('.onboarding-progress-step[data-ready="true"]').filter({ hasText: 'Runner' }).waitFor({
          state: 'visible',
          timeout: 15_000,
        });
        await page.getByRole('button', { name: /Wiki 지식 소스/ }).click();
        await guide.locator('.onboarding-progress-step[data-ready="true"]').filter({ hasText: 'Wiki' }).waitFor({
          state: 'visible',
          timeout: 15_000,
        });
        await page.getByRole('button', { name: /Calendar AI 확인/ }).click();
        await guide.locator('.onboarding-progress-step[data-ready="true"]').filter({ hasText: 'Calendar AI' }).waitFor({
          state: 'visible',
          timeout: 15_000,
        });
        const completeSetup = page.getByRole('button', { name: '설정 완료' });
        await completeSetup.waitFor({ state: 'visible', timeout: 10_000 });
        assert.equal(await completeSetup.isDisabled(), false, '설정 완료 must enable when all steps ready');
        await completeSetup.click();
        await page.waitForSelector('[data-testid="unified-calendar"]', { timeout: 20_000 });
        assert.equal(
          backend.getWorkspaceSettings().onboarding?.status,
          'completed',
          'first-user journey must complete onboarding',
        );
        await page.screenshot({ path: screenshotSetupCompletePath, fullPage: true });

        // Control Home / Mode A·B surface.
        await page.locator('.nav-primary').getByRole('button', { name: '에이전트', exact: true }).click();
        await page.locator('.agent-delegate-mode').getByRole('button', { name: 'Mode A · 목표만' }).waitFor({
          state: 'visible',
          timeout: 20_000,
        });
        await page.locator('.agent-delegate-mode').getByRole('button', { name: 'Mode B · 역할 지정' }).click();
        await page.getByLabel('Mode B 담당 에이전트').waitFor({ state: 'visible', timeout: 10_000 });
        await page.screenshot({ path: screenshotAgentsPath, fullPage: true });
        assert.ok(fs.statSync(screenshotAgentsPath).size > 10_000, 'agents Mode A/B screenshot missing/small');
      } else {
        await page.getByRole('button', { name: '나중에 하기' }).click();
        await page.waitForSelector('[data-testid="unified-calendar"]', { timeout: 20_000 });
        assert.equal(
          backend.getWorkspaceSettings().onboarding?.status,
          'dismissed',
          'guide dismissal must persist in Workspace settings',
        );
      }
    }

    if (phase8OfflineReconnect) {
      await page.getByText('Reconnect proof event', { exact: true }).first().waitFor({
        state: 'visible',
        timeout: 20_000,
      });
    }
    if (orcaShellAudit) await assertOrcaShellLayout(page, 'authenticated');
    await page.screenshot({ path: screenshotAfterPath, fullPage: true });
    assert.ok(fs.statSync(screenshotAfterPath).size > 10_000, 'calendar-after-login screenshot missing/small');
    if (orcaShellAudit) {
      await assertOrcaResponsiveLayout(page);
      await assertCalendarAiTopbarInteraction(page);
      await page.locator('.profile').click();
      await page.waitForSelector('.settings-overlay');
      const settingsSurface = await page.locator('.settings-overlay').evaluate((element) => {
        const sidebar = element.querySelector('.settings-sidebar')?.getBoundingClientRect();
        const section = element.querySelector('.settings-section')?.getBoundingClientRect();
        const heading = element.querySelector('.settings-section-head h3');
        return {
          sidebarWidth: sidebar?.width || 0,
          sectionWidth: section?.width || 0,
          headingSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
          horizontalOverflow: element.scrollWidth > element.clientWidth,
        };
      });
      assert.ok(Math.abs(settingsSurface.sidebarWidth - 240) <= 1, `settings sidebar width ${settingsSurface.sidebarWidth}`);
      assert.ok(settingsSurface.sectionWidth <= 761, `settings section width ${settingsSurface.sectionWidth}`);
      assert.ok(Math.abs(settingsSurface.headingSize - 15) <= 1, `settings heading size ${settingsSurface.headingSize}`);
      assert.equal(settingsSurface.horizontalOverflow, false, 'settings must not overflow horizontally');
      await page.screenshot({ path: screenshotSettingsPath, fullPage: true });
      await page.setViewportSize({ width: 768, height: 820 });
      await page.waitForTimeout(100);
      await page.screenshot({ path: screenshotSettingsCompactPath, fullPage: true });
      await page.setViewportSize({ width: 1320, height: 824 });
      await page.getByRole('button', { name: '설정 닫기' }).click();
      await page.waitForSelector('.settings-overlay', { state: 'detached' });
      await page.locator('.nav-more > summary').click();
      await page.locator('.nav-more .nav-item').filter({ hasText: '위젯' }).first().click();
      await page.waitForSelector('.widgets-showcase');
      const widgetSurface = await page.locator('.widgets-showcase').evaluate((element) => {
        const surfaceStyle = getComputedStyle(element);
        const card = element.querySelector('.widget-card');
        const cardStyle = card instanceof HTMLElement ? getComputedStyle(card) : null;
        return {
          surfaceBackgroundImage: surfaceStyle.backgroundImage,
          cardBackgroundImage: cardStyle?.backgroundImage || '',
          cardBoxShadow: cardStyle?.boxShadow || '',
          cardBackdropFilter: cardStyle?.backdropFilter || '',
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      assert.equal(widgetSurface.surfaceBackgroundImage, 'none');
      assert.equal(widgetSurface.cardBackgroundImage, 'none');
      assert.equal(widgetSurface.cardBoxShadow, 'none');
      assert.ok(!widgetSurface.cardBackdropFilter || widgetSurface.cardBackdropFilter === 'none');
      assert.equal(widgetSurface.horizontalOverflow, false, 'widgets must not overflow horizontally');
      await page.screenshot({ path: screenshotWidgetsPath, fullPage: true });
      await page.setViewportSize({ width: 768, height: 820 });
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
        'compact widgets must not overflow horizontally',
      );
      await page.screenshot({ path: screenshotWidgetsCompactPath, fullPage: true });
      await page.setViewportSize({ width: 1320, height: 824 });
      await page.locator('.nav-primary .nav-item').filter({ hasText: '캘린더' }).first().click();
      await page.locator('.event-pill').filter({ hasText: '프로덕션 디자인 검수' }).first().click();
      await page.waitForSelector('.detail-modal');
      const detailSurface = await page.locator('.detail-modal').evaluate((element) => {
        const modalStyle = getComputedStyle(element);
        const backdrop = element.closest('.detail-backdrop');
        const backdropStyle = backdrop instanceof HTMLElement ? getComputedStyle(backdrop) : null;
        return {
          boxShadow: modalStyle.boxShadow,
          radius: Number.parseFloat(modalStyle.borderRadius),
          backdropFilter: backdropStyle?.backdropFilter || '',
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      assert.equal(detailSurface.boxShadow, 'none');
      assert.ok(detailSurface.radius <= 10, `detail modal radius ${detailSurface.radius}`);
      assert.ok(!detailSurface.backdropFilter || detailSurface.backdropFilter === 'none');
      assert.equal(detailSurface.horizontalOverflow, false, 'detail modal must not overflow horizontally');
      await page.screenshot({ path: screenshotDetailModalPath, fullPage: true });
      await page.locator('.detail-date-trigger').click();
      await page.waitForSelector('.detail-date-popover');
      const detailDateSurface = await page.locator('.detail-date-popover').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundImage: style.backgroundImage,
          boxShadow: style.boxShadow,
          radius: Number.parseFloat(style.borderRadius),
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      assert.equal(detailDateSurface.backgroundImage, 'none');
      assert.equal(detailDateSurface.boxShadow, 'none');
      assert.ok(detailDateSurface.radius <= 10, `detail date popover radius ${detailDateSurface.radius}`);
      assert.equal(detailDateSurface.horizontalOverflow, false, 'detail date popover must not overflow horizontally');
      await page.screenshot({ path: screenshotDetailDatePopoverPath, fullPage: true });
      await page.locator('.detail-date-popover footer .primary').click();
      await page.waitForSelector('.detail-date-popover', { state: 'detached' });
      await page.locator('.detail-check').click();
      await page.waitForSelector('.completion-toast', { timeout: 10_000 });
      const toastSurface = await page.locator('.completion-toast').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundImage: style.backgroundImage,
          boxShadow: style.boxShadow,
          radius: Number.parseFloat(style.borderRadius),
        };
      });
      assert.equal(toastSurface.backgroundImage, 'none');
      assert.equal(toastSurface.boxShadow, 'none');
      assert.ok(toastSurface.radius <= 6, `completion toast radius ${toastSurface.radius}`);
      await page.screenshot({ path: screenshotCompletionToastPath, fullPage: true });
      await page.locator('.detail-close').click();
      await page.waitForSelector('.detail-modal', { state: 'detached' });
    }

    if (phase8OfflineReconnect) {
      backend.setAvailable(false);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('offline'));
      });
      await page.waitForSelector(
        '[data-testid="desktop-connectivity"][data-state="offline"]',
        { timeout: 10_000 },
      );

      // A reconnect attempt while the Gateway is still unavailable must retain the snapshot.
      await page.evaluate(() => {
        window.dispatchEvent(new Event('online'));
      });
      await page.waitForTimeout(8_000);
      const failedRetryState = await page
        .getByTestId('desktop-connectivity')
        .getAttribute('data-state');
      assert.equal(
        failedRetryState,
        'offline',
        `failed reconnect must return to offline; body=${(await page.locator('body').innerText()).slice(0, 500)}`,
      );
      assert.equal(
        await page.getByText('Reconnect proof event', { exact: true }).count(),
        1,
        'offline hydrate must retain the last successful Calendar snapshot',
      );
      const offlineCopy = await page.getByTestId('desktop-connectivity').innerText();
      assert.match(offlineCopy, /연결 끊김/);
      assert.match(offlineCopy, /표시 중인 데이터는 유지됩니다/);
      assert.match(offlineCopy, /마지막 동기화/);
      const offlineSession = await page.evaluate(async () => (
        window.hermesDesktop?.getSessionStatus?.()
      ));
      assert.equal(offlineSession?.signedIn, true, 'offline state must not sign the owner out');
      await page.screenshot({ path: screenshotOfflinePath, fullPage: true });
      assert.ok(fs.statSync(screenshotOfflinePath).size > 10_000, 'offline screenshot missing/small');

      const successfulRequestsBeforeRecovery = backend.getReconnectSuccessfulRequests();
      backend.setAvailable(true);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('online'));
      });
      await page.waitForSelector(
        '[data-testid="desktop-connectivity"][data-state="recovered"]',
        { timeout: 20_000 },
      );
      assert.ok(
        backend.getReconnectSuccessfulRequests() > successfulRequestsBeforeRecovery,
        'online recovery must perform fresh authenticated product requests',
      );
      assert.equal(
        await page.getByText('Reconnect proof event', { exact: true }).count(),
        1,
        'recovered Calendar must still contain the persisted event',
      );
      assert.equal(
        await page.getByRole('button', { name: /AuthKit으로 계속하기|Google 또는 이메일로 계속하기/ }).count(),
        0,
        'reconnect must not require login',
      );
      await page.screenshot({ path: screenshotRecoveredPath, fullPage: true });
      assert.ok(fs.statSync(screenshotRecoveredPath).size > 10_000, 'recovered screenshot missing/small');
    }

    assertSecureSessionEncryptedOnDisk();
    assertSettingsHaveNoSecrets();
    if (phase8OfflineReconnect) {
      assert.equal(fs.existsSync(workspaceSnapshotFile), true, 'online hydration must persist Workspace snapshot');
      const onlineSnapshot = await page.evaluate(async () => window.hermesDesktop?.readWorkspaceSnapshot?.());
      assert.match(
        JSON.stringify(onlineSnapshot?.data),
        /Reconnect proof event/,
        'online Workspace snapshot must contain the synchronized Calendar event',
      );
    }

    try {
      await receiveAuthUrl(electronApp, goodUrl);
    } catch {
      // expected
    }
    assert.equal(backend.getCompleteCount(), 1, 'reused callback must not complete twice');

    const close1 = await closeApp(electronApp);
    assert.equal(close1.exited, true, 'first Electron process must exit before relaunch');
    electronApp = null;

    // Session file must still exist after process exit (restart restore input).
    assertSecureSessionEncryptedOnDisk();
    assertSettingsHaveNoSecrets();

    if (phase8OfflineReconnect) backend.setAvailable(false);

    // Relaunch same userData — HARD requirement: session restored without re-login.
    electronApp = await launchApp({ apiBaseUrl: backend.baseUrl });
    let page2 = await electronApp.firstWindow();
    await page2.waitForTimeout(1_500);

    const status = await electronApp.evaluate(async () => {
      const bridge = globalThis.__agentCalendarE2E;
      // Prefer IPC public status through renderer when available.
      return null;
    }).catch(() => null);
    void status;

    const sessionStatus = await page2.evaluate(async () => {
      if (!window.hermesDesktop?.getSessionStatus) return null;
      return window.hermesDesktop.getSessionStatus();
    });
    assert.ok(sessionStatus, 'session status API must exist');
    assert.equal(sessionStatus.signedIn, true, `restart must restore session: ${JSON.stringify(sessionStatus)}`);
    assert.equal(sessionStatus.workspaceId, 'ws_e2e');

    const loginButtons = await page2.getByRole('button', { name: /AuthKit으로 계속하기|Google 또는 이메일로 계속하기/ }).count();
    assert.equal(loginButtons, 0, 'login screen must not appear after restart restore');
    assert.equal(backend.getCompleteCount(), 1, 'restart restore must not call desktop/complete again');
    if (orcaShellAudit) await assertOrcaShellLayout(page2, 'restart');
    if (phase8OfflineReconnect) {
      await page2.getByTestId('desktop-connectivity').waitFor({ state: 'visible', timeout: 20_000 });
      const coldSnapshotEncryptedBytes = fs.existsSync(workspaceSnapshotFile)
        ? fs.statSync(workspaceSnapshotFile).size
        : 0;
      const coldSnapshot = await page2.evaluate(async () => window.hermesDesktop?.readWorkspaceSnapshot?.());
      assert.ok(
        coldSnapshot,
        `same-session cold-start snapshot must remain readable (${coldSnapshotEncryptedBytes} encrypted bytes)`,
      );
      assert.match(
        JSON.stringify(coldSnapshot.data),
        /Reconnect proof event/,
        'cold-start snapshot must retain the last synchronized Calendar event',
      );
      assert.equal(
        await page2.getByTestId('desktop-connectivity').getAttribute('data-state'),
        'offline',
        'cold start without Gateway must expose offline state',
      );
      await page2.getByText('Reconnect proof event', { exact: true }).first().waitFor({
        state: 'visible',
        timeout: 20_000,
      });
      const coldCopy = await page2.getByTestId('desktop-connectivity').innerText();
      assert.match(coldCopy, /마지막 동기화/);
      assert.match(coldCopy, /표시 중인 데이터는 유지됩니다/);
      assert.equal(fs.existsSync(workspaceSnapshotFile), true, 'cold-start snapshot must exist');
      assert.doesNotMatch(
        fs.readFileSync(workspaceSnapshotFile).toString('utf8'),
        /Reconnect proof event|ws_e2e|user_e2e/,
        'cold-start snapshot must not expose Workspace data or owner identity as plaintext',
      );
    }
    await page2.screenshot({ path: screenshotRestartPath, fullPage: true });
    assert.ok(fs.statSync(screenshotRestartPath).size > 10_000, 'calendar-after-restart screenshot missing/small');
    if (phase8OfflineReconnect) {
      backend.setAvailable(true);
      await page2.evaluate(() => {
        window.dispatchEvent(new Event('online'));
      });
      await page2.waitForSelector(
        '[data-testid="desktop-connectivity"][data-state="recovered"]',
        { timeout: 20_000 },
      );
      assert.equal(
        await page2.getByText('Reconnect proof event', { exact: true }).count(),
        1,
        'cold-start recovery must replace the cache with current Workspace truth',
      );
      await page2.screenshot({ path: screenshotColdRecoveredPath, fullPage: true });
      assert.ok(fs.statSync(screenshotColdRecoveredPath).size > 10_000, 'cold-start recovery screenshot missing/small');
    }
    if (phase8GoogleOAuth) {
      await page2.getByTestId('calendar-source-list').waitFor({ state: 'visible', timeout: 20_000 });
      const sourceTruth = await page2.getByTestId('calendar-source-list').innerText();
      assert.match(sourceTruth, /Google Calendar/);
      assert.match(sourceTruth, /동기화 2026-07-25T03:00:00/);
      assert.equal(backend.getCalendarFinalizeCount(), 1, 'restart must not finalize Google OAuth again');
    }
    if (phase8SessionTruth) {
      await page2.getByTestId('open-settings').click();
      await page2.getByTestId('settings-open-onboarding').waitFor({ state: 'visible' });
      await page2.getByTestId('settings-open-onboarding').click();
      await page2.getByTestId('onboarding-guide').waitFor({ state: 'visible' });
      assert.equal(
        backend.getWorkspaceSettings().onboarding?.status,
        'dismissed',
        'manually reopening the guide must not erase its persisted Workspace status',
      );
    }
    if (phase8DesktopRelease) {
      const nativeDark = await electronApp.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
      assert.equal(nativeDark, e2eTheme === 'dark', 'native recovery theme must match Desktop settings');
      await page2.getByTestId('open-settings').click();
      await page2.getByTestId('settings-nav-release').click();
      const releasePanel = page2.getByTestId('desktop-release-panel');
      await releasePanel.waitFor({ state: 'visible' });
      assert.equal(await releasePanel.getAttribute('data-phase'), 'idle');
      await page2.getByTestId('desktop-release-check').click();
      await page2.waitForSelector('[data-testid="desktop-release-panel"][data-phase="available"]');
      assert.match(await releasePanel.innerText(), /0\.1\.0 → 0\.1\.1/);
      await page2.getByTestId('desktop-release-download').click();
      await page2.waitForSelector('[data-testid="desktop-release-panel"][data-phase="ready"]');
      assert.match(await releasePanel.innerText(), /설치 준비가 끝났습니다/);
      await releasePanel.scrollIntoViewIfNeeded();
      await page2.screenshot({ path: screenshotReleasePath, fullPage: true });
      assert.ok(fs.statSync(screenshotReleasePath).size > 10_000, 'release settings screenshot missing/small');
      await page2.getByTestId('desktop-release-install').click();
      await page2.waitForSelector('[data-testid="desktop-release-panel"][data-phase="installing"]');
      await page2.getByRole('button', { name: '설정 닫기' }).click();

      for (let index = 0; index < 2; index += 1) {
        const simulated = await simulateRendererGoneAndWait(electronApp);
        assert.equal(simulated.decision.action, 'reload');
        page2 = simulated.page;
        await page2.waitForSelector('[data-testid="desktop-recovery-notice"][data-phase="recovered"]', {
          timeout: 20_000,
        });
        await page2.getByTestId('open-settings').waitFor({ state: 'visible', timeout: 20_000 });
        assert.match(await page2.getByTestId('desktop-recovery-notice').innerText(), /마지막 동기화 보관본/);
        await page2.getByTestId('desktop-recovery-notice').getByRole('button', { name: '확인' }).click();
      }

      const halted = await simulateRendererGoneAndWait(electronApp);
      assert.equal(halted.decision.action, 'fallback');
      page2 = halted.page;
      await page2.waitForURL(/crash-recovery\.html/, { timeout: 20_000 });
      await page2.getByText('Agent Calendar를 안전하게 멈췄습니다').waitFor({ state: 'visible' });
      await page2.screenshot({ path: screenshotRecoveryPath, fullPage: true });
      assert.ok(fs.statSync(screenshotRecoveryPath).size > 10_000, 'safe recovery screenshot missing/small');
      await page2.getByRole('link', { name: /다시 열기/ }).click();
      await page2.waitForURL(/index\.html\?recovery=manual/, { timeout: 20_000 });
      page2 = electronApp.windows()[0];
      const recoveryReturn = await page2.evaluate(async () => ({
        settings: await window.hermesDesktop?.getSettings?.(),
        session: await window.hermesDesktop?.getSessionStatus?.(),
        text: document.body.innerText.slice(0, 800),
      }));
      assert.equal(
        recoveryReturn.session?.signedIn,
        true,
        `manual recovery must preserve the encrypted session: ${JSON.stringify(recoveryReturn)}`,
      );
      try {
        await page2.getByTestId('open-settings').waitFor({ state: 'visible', timeout: 20_000 });
      } catch (error) {
        const returnSurface = await page2.evaluate(() => ({
          url: location.href,
          text: document.body.innerText.slice(0, 1200),
          html: document.body.innerHTML.slice(0, 1200),
        }));
        throw new Error(`manual recovery surface did not restore: ${JSON.stringify({ recoveryReturn, returnSurface })}`, {
          cause: error,
        });
      }
      await page2.waitForSelector('[data-testid="desktop-recovery-notice"][data-phase="halted"]');
    }

    // Logout → login screen.
    await page2.evaluate(async () => {
      await window.hermesDesktop?.logoutAuth?.();
    });
    await page2.reload();
    await page2.waitForSelector('[data-testid="login-authkit-continue"]', { timeout: 20_000 });
    assert.equal(fs.existsSync(sessionFile), false, 'logout must clear secure session file');
    assert.equal(fs.existsSync(workspaceSnapshotFile), false, 'logout must clear encrypted Workspace snapshot');

    const close2 = await closeApp(electronApp);
    assert.equal(close2.exited, true, 'second Electron process must exit');
    electronApp = null;

    return {
      ok: true,
      completeCount: backend.getCompleteCount(),
      screenshots: {
        before: screenshotBeforePath,
        guide: firstRunGuide ? screenshotGuidePath : null,
        googleError: phase8GoogleOAuth ? screenshotGoogleErrorPath : null,
        googleSuccess: phase8GoogleOAuth ? screenshotGoogleSuccessPath : null,
        after: screenshotAfterPath,
        offline: phase8OfflineReconnect ? screenshotOfflinePath : null,
        recovered: phase8OfflineReconnect ? screenshotRecoveredPath : null,
        restart: screenshotRestartPath,
        coldRecovered: phase8OfflineReconnect ? screenshotColdRecoveredPath : null,
        release: phase8DesktopRelease ? screenshotReleasePath : null,
        recovery: phase8DesktopRelease ? screenshotRecoveryPath : null,
      },
      userData: userDataName,
      safeStorage: true,
      restartRestore: true,
      staleProfileRecovery: phase8SessionTruth,
      googleCalendarOAuth: phase8GoogleOAuth,
      offlineReconnect: phase8OfflineReconnect,
      coldStartOffline: phase8OfflineReconnect,
      desktopRelease: phase8DesktopRelease,
      orcaShellAudit,
      protectedRequestsBeforeLogin: phase8SessionTruth ? 0 : null,
    };
  } finally {
    await closeApp(electronApp);
  }
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const backend = await createFakeAuthBackend();

  let hardTimer = null;
  const hardTimeout = new Promise((_, reject) => {
    hardTimer = setTimeout(() => {
      reject(new Error(`E2E hard timeout after ${HARD_TIMEOUT_MS}ms`));
    }, HARD_TIMEOUT_MS);
  });

  let result;
  try {
    // Race scenario against hard timeout; clearTimeout in finally so success exits immediately
    // (no 90s lingering timer handle keeping the event loop alive).
    result = await Promise.race([runScenario(backend), hardTimeout]);
  } finally {
    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }
    try {
      await backend.close();
    } catch {
      // ignore
    }
    // Keep screenshots; remove only this run's userData.
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
