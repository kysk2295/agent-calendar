'use strict';

/**
 * Phase 4 Unified Calendar ETE — fake Google provider fixture, real Desktop surface.
 * Login → seed fake provider → sync → show internal + agent-work + Google entries
 * with source/coverage → external create reconciled → backend + Desktop restart.
 * Live Google Cloud OAuth is not exercised.
 */

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const { runMigrations } = require('../../backend/app/db/migrate');
const { defaultRunBin: runBin } = require('../../backend/app/lib/local-postgres-lifecycle');
const { createRailwayGatewayServer } = require('../../backend/app/railway-gateway-server');
const { createPhase1Runtime } = require('../../backend/app/lib/phase1-auth-routes');
const { resolvePostgresBinDir } = require('../../backend/app/lib/phase0-snapshot-restore');
const { issueSessionForVerifiedSubject } = require('../../backend/app/lib/workspace-auth-session');
const { resolveWorkspaceScope } = require('../../backend/app/lib/workspace-scope');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const artifactDir = path.join(desktopRoot, 'test-results', 'phase4-unified-calendar');
const evidencePath = path.join(repoRoot, 'docs/operations/evidence/2026-07-24-phase4-unified-calendar-google.json');
const userDataName = `Agent Calendar Phase4 Unified ${process.pid}`;
const userData = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
const settingsFile = path.join(userData, 'settings.json');
const HARD_TIMEOUT_MS = Number(process.env.AGENT_CALENDAR_E2E_TIMEOUT_MS || 300_000);
const LOCAL_ROLE = 'phase4e2e';
const DATABASE = 'phase4_e2e';

const shots = {
  afterLogin: path.join(artifactDir, '01-after-login.png'),
  connected: path.join(artifactDir, '02-google-connected.png'),
  synced: path.join(artifactDir, '03-synced-unified.png'),
  externalCreate: path.join(artifactDir, '04-external-create.png'),
  afterBackendRestart: path.join(artifactDir, '05-backend-restart.png'),
  afterDesktopRestart: path.join(artifactDir, '06-desktop-restart.png'),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((e) => (e ? reject(e) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function waitForReady(binDir, socketDir, port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      runBin(binDir, 'pg_isready', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE], { timeout: 2000 });
      return;
    } catch { await sleep(100); }
  }
  throw new Error('PG not ready');
}

function stopCluster(binDir, dataDir) {
  try { runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 }); } catch { /* ignore */ }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function forceKillPid(pid) {
  if (!pid || !pidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function ensureCleanUserData(apiBaseUrl) {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  // Remove prior screenshots so failed captures cannot leave stale identical hashes.
  for (const shot of Object.values(shots)) {
    try { fs.rmSync(shot, { force: true }); } catch { /* ignore */ }
  }
  fs.writeFileSync(settingsFile, `${JSON.stringify({
    apiBaseUrl, apiToken: '', theme: 'default', auth: null,
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2)}\n`);
}

async function switchCalendarView(page, label, selector) {
  const btn = page.locator('.screen-toolbar button', { hasText: new RegExp(`^${label}$`) }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(400);
  } else {
    await page.getByRole('button', { name: new RegExp(`^${label}$`) }).click().catch(() => {});
    await page.waitForTimeout(400);
  }
  if (selector) {
    await page.waitForSelector(selector, { timeout: 8_000 }).catch(() => {});
  }
}

function writeSettings(apiBaseUrl) {
  const previous = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  fs.writeFileSync(settingsFile, `${JSON.stringify({
    ...previous,
    apiBaseUrl,
    apiToken: '',
  }, null, 2)}\n`);
}

async function startPostgres() {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw new Error('PG binaries missing');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-ete-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  const logFile = path.join(workDir, 'postgres.log');
  fs.mkdirSync(socketDir, { recursive: true });
  const pgPort = await freePort();
  runBin(binDir, 'initdb', ['-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8'], { timeout: 60_000 });
  runBin(binDir, 'pg_ctl', [
    '-D', dataDir, '-l', logFile,
    '-o', `-p ${pgPort} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
    'start',
  ], { timeout: 30_000 });
  await waitForReady(binDir, socketDir, pgPort);
  runBin(binDir, 'createdb', ['-h', socketDir, '-p', String(pgPort), '-U', LOCAL_ROLE, DATABASE], { timeout: 15_000 });
  const connectionString = `postgresql://${encodeURIComponent(LOCAL_ROLE)}@/${encodeURIComponent(DATABASE)}?host=${encodeURIComponent(socketDir)}&port=${pgPort}`;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, ssl: false, connectionTimeoutMillis: 10_000 });
  await runMigrations({ pool });
  return { binDir, workDir, dataDir, socketDir, pool, connectionString };
}

function createAuthKitState() {
  let lastStart = null;
  let completeCount = 0;
  return {
    getLastStart: () => lastStart,
    getCompleteCount: () => completeCount,
    authKit: {
      async getAuthorizationUrlWithPKCE({ state }) {
        lastStart = { state, codeVerifier: `v_${Date.now()}` };
        return { url: `https://authkit.test/authorize?state=${state}`, codeVerifier: lastStart.codeVerifier };
      },
      async authenticateWithCodeAndVerifier({ code }) {
        if (!code) throw Object.assign(new Error('bad'), { code: 'WORKOS_EXCHANGE_FAILED' });
        completeCount += 1;
        return {
          user: {
            id: 'workos_phase4',
            email: 'phase4@example.com',
            firstName: 'Phase4',
            lastName: 'Owner',
            emailVerified: true,
          },
        };
      },
    },
  };
}

function phase4Env() {
  return {
    WORKSPACE_AUTH_MODE: 'production',
    AGENT_CALENDAR_FAKE_GOOGLE: '1',
    UNIFIED_CALENDAR_FAKE_GOOGLE: '1',
    UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
  };
}

async function startHttpServer({ pool, authKit, fixedPort = null }) {
  const runtime = createPhase1Runtime({
    pool,
    authKit,
    workosConfig: { clientId: 'client_phase4', apiKeyConfigured: true },
    env: phase4Env(),
  });
  const server = createRailwayGatewayServer({
    env: phase4Env(),
    phase1Runtime: runtime,
    phase1Pool: pool,
    gatewayStore: { getState: () => ({ tasks: [], events: [] }), ready: Promise.resolve() },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const baseUrl = await new Promise((resolve) => {
    const host = '127.0.0.1';
    if (fixedPort) {
      server.listen(fixedPort, host, () => resolve(`http://${host}:${fixedPort}`));
    } else {
      server.listen(0, host, () => resolve(`http://${host}:${server.address().port}`));
    }
  });
  return {
    server,
    runtime,
    baseUrl,
    async close() {
      await new Promise((r) => server.close(() => r()));
    },
  };
}

async function launchApp(apiBaseUrl) {
  const mainJs = path.join(desktopRoot, 'dist-electron', 'main.js');
  assert.ok(fs.existsSync(mainJs), 'build desktop first');
  writeSettings(apiBaseUrl);
  const electronPath = require('electron');
  return electron.launch({
    executablePath: typeof electronPath === 'string' ? electronPath : undefined,
    args: [mainJs],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENT_CALENDAR_USER_DATA_NAME: userDataName,
      AGENT_CALENDAR_E2E_AUTH: '1',
      VITE_DEV_SERVER_URL: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
}

async function receiveAuthUrl(app, url) {
  return app.evaluate(async (_e, callbackUrl) => {
    const bridge = globalThis.__agentCalendarE2E;
    if (!bridge) throw new Error('E2E bridge missing');
    return bridge.receiveAuthUrl(callbackUrl);
  }, url);
}

async function closeApp(app) {
  if (!app) return;
  let pid = null;
  try { pid = app.process().pid; } catch { /* ignore */ }
  try { await app.evaluate(async ({ app: a }) => a.exit(0)).catch(() => {}); } catch { /* ignore */ }
  try { await Promise.race([app.close(), sleep(2000)]); } catch { /* ignore */ }
  if (pid && pidAlive(pid)) forceKillPid(pid);
  await sleep(400);
}

async function httpJson(baseUrl, method, pathname, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function resolveWorkspaceToken(pool, providerSubject = 'workos_phase4') {
  const identity = await pool.query(
    `select ai.user_id, ai.provider_subject
     from auth_identities ai
     where ai.provider = 'workos' and ai.provider_subject = $1
     limit 1`,
    [providerSubject],
  );
  if (!identity.rowCount) {
    const byPayload = await pool.query(
      `select id as user_id from users
       where payload->>'email' = 'phase4@example.com' or display_name ilike '%Phase4%'
       order by created_at desc
       limit 1`,
    );
    if (!byPayload.rowCount) throw new Error('phase4 user missing after login');
    const membership = await pool.query(
      `select workspace_id from workspace_memberships where user_id = $1 and status = 'active' order by created_at asc limit 1`,
      [byPayload.rows[0].user_id],
    );
    if (!membership.rowCount) throw new Error('phase4 membership missing');
    // Prefer issuing via whatever identity exists for this user
    const anyId = await pool.query(
      `select provider, provider_subject from auth_identities where user_id = $1 limit 1`,
      [byPayload.rows[0].user_id],
    );
    if (!anyId.rowCount) throw new Error('phase4 auth identity missing');
    const session = await issueSessionForVerifiedSubject(pool, {
      provider: anyId.rows[0].provider,
      providerSubject: anyId.rows[0].provider_subject,
    });
    return {
      token: session.accessToken,
      workspaceId: session.workspaceId,
      userId: session.userId,
    };
  }
  const session = await issueSessionForVerifiedSubject(pool, {
    provider: 'workos',
    providerSubject,
  });
  return {
    token: session.accessToken,
    workspaceId: session.workspaceId,
    userId: session.userId,
  };
}

async function seedInternalAndAgent(pool, workspaceId) {
  const day = new Date();
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, '0');
  const d = String(day.getUTCDate()).padStart(2, '0');
  const date = `${y}-${m}-${d}`;
  await pool.query(
    `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
     values ($1, null, $2, $3::timestamptz, $4::jsonb, $5)
     on conflict (id) do update set title = excluded.title, payload = excluded.payload`,
    [
      `int-p4-${workspaceId.slice(0, 8)}`,
      'Internal meeting P4',
      `${date}T03:00:00.000Z`,
      JSON.stringify({
        endsAt: `${date}T04:00:00.000Z`,
        source: 'calendar-event',
        date,
        time: '03:00',
      }),
      workspaceId,
    ],
  );
  await pool.query(
    `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
     values ($1, null, $2, $3::timestamptz, $4::jsonb, $5)
     on conflict (id) do update set title = excluded.title, payload = excluded.payload`,
    [
      `agent-p4-${workspaceId.slice(0, 8)}`,
      'Agent result: Phase4 calendar',
      `${date}T12:00:00.000Z`,
      JSON.stringify({
        source: 'agent-work',
        endsAt: `${date}T13:00:00.000Z`,
        date,
        time: '12:00',
      }),
      workspaceId,
    ],
  );
}

async function cleanup({ electronApp, http, pg, runtime } = {}) {
  try { if (runtime && runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers(); } catch { /* ignore */ }
  try { await closeApp(electronApp); } catch { /* ignore */ }
  try { if (http) await http.close(); } catch { /* ignore */ }
  if (pg) {
    try { await pg.pool.end(); } catch { /* ignore */ }
    try { stopCluster(pg.binDir, pg.dataDir); } catch { /* ignore */ }
    try { fs.rmSync(pg.workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  const started = Date.now();
  let hard = null;
  let pg = null;
  let http = null;
  let electronApp = null;
  let authState = null;
  let fixedPort = null;
  let exitCode = 0;
  const results = {
    schemaVersion: 1,
    slice: 'phase4-unified-calendar-google',
    date: '2026-07-24',
    status: 'running',
    liveGoogleOAuth: 'not exercised',
  };

  hard = setTimeout(() => {
    console.error('HARD_TIMEOUT');
    // Best-effort sync stop of orphan PG on hard timeout
    if (pg && pg.binDir && pg.dataDir) stopCluster(pg.binDir, pg.dataDir);
    process.exit(2);
  }, HARD_TIMEOUT_MS);

  try {
    execFileSync('npm', ['run', 'build'], { cwd: desktopRoot, stdio: 'inherit', timeout: 180_000 });
    pg = await startPostgres();
    authState = createAuthKitState();
    http = await startHttpServer({ pool: pg.pool, authKit: authState.authKit });
    fixedPort = Number(new URL(http.baseUrl).port);
    ensureCleanUserData(http.baseUrl);

    electronApp = await launchApp(http.baseUrl);
    let page = await electronApp.firstWindow();

    // 1) Login
    await page.waitForSelector('button:has-text("AuthKit으로 계속하기")', { timeout: 25_000 });
    await page.getByRole('button', { name: /AuthKit으로 계속하기/ }).click();
    await page.waitForTimeout(500);
    const pending = authState.getLastStart();
    assert.ok(pending);
    await receiveAuthUrl(electronApp, `agent-calendar://auth/callback?code=p4&state=${encodeURIComponent(pending.state)}`);
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some((b) => /AuthKit으로 계속하기/.test(b.textContent || '')), null, { timeout: 25_000 });
    assert.equal(authState.getCompleteCount(), 1);

    // Ensure calendar surface
    const calNav = page.getByRole('button', { name: /캘린더|Calendar/i }).first();
    if (await calNav.count()) await calNav.click().catch(() => {});
    await page.waitForSelector('[data-testid="unified-calendar"]', { timeout: 20_000 });
    await page.screenshot({ path: shots.afterLogin, fullPage: true });

    // Seed internal + agent-work projection for Workspace A (via resolved membership)
    const { token, workspaceId, userId } = await resolveWorkspaceToken(pg.pool);
    await seedInternalAndAgent(pg.pool, workspaceId);

    // 2) Compose the Phase 4 fake provider directly; no fake HTTP route exists in production.
    const workspaceScope = await resolveWorkspaceScope(pg.pool, { userId, workspaceId });
    const fakeConnect = await http.runtime.unifiedCalendar.connectFakeGoogle(workspaceScope, {
      label: 'Google Calendar',
    });
    assert.ok(fakeConnect.source && fakeConnect.source.id, JSON.stringify(fakeConnect));
    await page.reload();
    const calendarNavAfterSeed = page.getByRole('button', { name: /캘린더|Calendar/i }).first();
    if (await calendarNavAfterSeed.count()) await calendarNavAfterSeed.click().catch(() => {});
    await page.waitForSelector('[data-testid="unified-calendar"]', { timeout: 20_000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="calendar-source-summary"]');
      return el && /연결됨|google/i.test(el.textContent || '');
    }, null, { timeout: 20_000 });
    await page.waitForSelector('[data-testid="calendar-sync-sources"]', { timeout: 15_000 });
    await page.screenshot({ path: shots.connected, fullPage: true });

    // Unsynchronized coverage should be visible before sync (or after connect before sync)
    const coverageBefore = await page.getAttribute('[data-testid="calendar-coverage-note"]', 'data-coverage');

    // 3) Sync sources via UI + API verify (API is source of truth for coverage/entries)
    await page.getByTestId('calendar-sync-sources').click();
    await page.waitForTimeout(1200);
    const sourcesAfter = await httpJson(http.baseUrl, 'GET', '/api/calendar/sources', { token });
    assert.equal(sourcesAfter.status, 200, JSON.stringify(sourcesAfter.json));
    const googleSource = (sourcesAfter.json.sources || []).find((s) => s.provider === 'google');
    assert.ok(googleSource, 'google source missing after connect');
    // Sync + query use the same visible window as Desktop hydrate (month-1 start → month+2 end).
    const now = new Date();
    const rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59).toISOString();
    const syncApi = await httpJson(http.baseUrl, 'POST', `/api/calendar/sources/${googleSource.id}/sync`, {
      token,
      body: { full: true, rangeStart, rangeEnd },
    });
    assert.equal(syncApi.status, 200, JSON.stringify(syncApi.json));

    const unified = await httpJson(
      http.baseUrl,
      'GET',
      `/api/calendar/unified?from=${encodeURIComponent(rangeStart)}&to=${encodeURIComponent(rangeEnd)}`,
      { token },
    );
    assert.equal(unified.status, 200, JSON.stringify(unified.json));
    const entries = unified.json.entries || [];
    assert.ok(entries.some((e) => /Google timed meeting/i.test(e.title)), JSON.stringify(entries.map((e) => e.title)));
    assert.ok(entries.some((e) => /Google all-day|Google daily/i.test(e.title)));
    assert.ok(entries.some((e) => /Internal meeting P4/i.test(e.title)));
    assert.ok(entries.some((e) => /Agent result: Phase4/i.test(e.title)));
    const googleCov = (unified.json.coverage || []).find((c) => c.sourceId === googleSource.id);
    assert.ok(googleCov && googleCov.state === 'complete', JSON.stringify(unified.json.coverage));

    // Force Desktop rehydrate onto calendar surface
    const todayBtn = page.getByRole('button', { name: '오늘' });
    if (await todayBtn.count()) await todayBtn.click().catch(() => {});
    await page.getByTestId('calendar-sync-sources').click().catch(() => {});
    await page.waitForFunction(() => {
      const text = document.body ? document.body.innerText : '';
      return /Google timed meeting|Google all-day focus|Google daily standup/i.test(text)
        && /Internal meeting|Agent result/i.test(text)
        && /커버리지 완료|connected/i.test(text);
    }, null, { timeout: 45_000 });
    // Day view shows more pills without month truncation
    await page.getByRole('button', { name: '일' }).click().catch(() => {});
    await page.waitForTimeout(500);
    const bodySynced = await page.locator('body').innerText();
    assert.match(bodySynced, /Google timed meeting|Google all-day focus|Google daily standup/);
    assert.match(bodySynced, /Internal meeting|Agent result/);
    assert.match(bodySynced, /커버리지 완료|connected/i);
    await page.screenshot({ path: shots.synced, fullPage: true });

    // 4) External create (provider-reconciled) — exactly ONE create for one idempotency key.
    // Do NOT also click UI create (that used a second Date.now() key and forked a twin event).
    await page.getByRole('button', { name: '월' }).click().catch(() => {});
    assert.ok(await page.getByTestId('calendar-external-create').count(), 'create button present');
    const dayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const extIdempotencyKey = `ete-ext-create-${workspaceId}-${dayKey}`;
    const createApi = await httpJson(http.baseUrl, 'POST', '/api/calendar/external/events', {
      token,
      body: {
        sourceId: googleSource.id,
        title: 'Google external create',
        startsAt: `${dayKey}T10:00:00.000Z`,
        endsAt: `${dayKey}T11:00:00.000Z`,
        allDay: false,
        timezone: 'Asia/Seoul',
        idempotencyKey: extIdempotencyKey,
      },
    });
    assert.equal(createApi.status, 200, JSON.stringify(createApi.json));
    assert.equal(createApi.json.ok, true);
    assert.equal(createApi.json.receipt.status, 'reconciled');
    const createdProviderEventId = createApi.json.receipt.providerEventId
      || createApi.json.entry?.providerEventId
      || createApi.json.event?.id
      || null;

    // Replay same key must not duplicate provider projection
    const createReplay = await httpJson(http.baseUrl, 'POST', '/api/calendar/external/events', {
      token,
      body: {
        sourceId: googleSource.id,
        title: 'Google external create',
        startsAt: `${dayKey}T10:00:00.000Z`,
        endsAt: `${dayKey}T11:00:00.000Z`,
        allDay: false,
        timezone: 'Asia/Seoul',
        idempotencyKey: extIdempotencyKey,
      },
    });
    assert.equal(createReplay.status, 200, JSON.stringify(createReplay.json));
    assert.ok(createReplay.json.ok);

    // Sync after create must rebuild occurrences without forking a second row for same provider event.
    await page.getByTestId('calendar-sync-sources').click().catch(() => {});
    const syncAfterCreate = await httpJson(http.baseUrl, 'POST', `/api/calendar/sources/${googleSource.id}/sync`, {
      token,
      body: { full: false, rangeStart, rangeEnd },
    });
    assert.equal(syncAfterCreate.status, 200, JSON.stringify(syncAfterCreate.json));

    const unifiedAfterCreate = await httpJson(
      http.baseUrl,
      'GET',
      `/api/calendar/unified?from=${encodeURIComponent(rangeStart)}&to=${encodeURIComponent(rangeEnd)}`,
      { token },
    );
    assert.equal(unifiedAfterCreate.status, 200);
    const extAfterCreate = (unifiedAfterCreate.json.entries || []).filter((e) => /Google external create/i.test(e.title || ''));
    assert.equal(
      extAfterCreate.length,
      1,
      `expected exactly 1 Google external create after create+sync, got ${extAfterCreate.length}: ${JSON.stringify(extAfterCreate)}`,
    );
    if (createdProviderEventId) {
      assert.equal(extAfterCreate[0].providerEventId, createdProviderEventId);
    }
    const occDb = await pg.pool.query(
      `select count(*)::int as n from calendar_occurrences
       where workspace_id = $1 and source_id = $2 and title = 'Google external create'`,
      [workspaceId, googleSource.id],
    );
    assert.equal(occDb.rows[0].n, 1, `DB occurrences for external create must be 1, got ${occDb.rows[0].n}`);

    await page.waitForFunction(() => {
      const text = document.body ? document.body.innerText : '';
      return /Google external create/i.test(text);
    }, null, { timeout: 30_000 });
    await page.screenshot({ path: shots.externalCreate, fullPage: true });

    // Verify mutation receipt via API
    const sources = await httpJson(http.baseUrl, 'GET', '/api/calendar/sources', { token });
    assert.equal(sources.status, 200);
    assert.ok((sources.json.sources || []).some((s) => s.provider === 'google' && s.status === 'connected'));
    const sourceId = (sources.json.sources || []).find((s) => s.provider === 'google').id;
    const receipts = await pg.pool.query(
      `select status, operation from calendar_mutation_receipts where workspace_id = $1 and source_id = $2`,
      [workspaceId, sourceId],
    );
    assert.ok(receipts.rows.some((r) => r.status === 'reconciled' && r.operation === 'create'));

    // Workspace B isolation (hostile)
    await pg.pool.query(
      `insert into users (id, display_name, status)
       values ('user_b_p4', 'B', 'active') on conflict do nothing`,
    );
    await pg.pool.query(
      `insert into workspaces (id, name, status) values ('ws_b_p4', 'B', 'active') on conflict do nothing`,
    );
    await pg.pool.query(
      `insert into workspace_memberships (id, workspace_id, user_id, role, status)
       values ('mem_b_p4', 'ws_b_p4', 'user_b_p4', 'owner', 'active') on conflict do nothing`,
    );
    await pg.pool.query(
      `insert into auth_identities (id, user_id, provider, provider_subject)
       values ('id_b_p4', 'user_b_p4', 'test', 'subject-b-p4') on conflict do nothing`,
    );
    const sessionB = await issueSessionForVerifiedSubject(pg.pool, {
      provider: 'test',
      providerSubject: 'subject-b-p4',
      workspaceId: 'ws_b_p4',
    });
    const tokenB = sessionB.accessToken;
    const crossSources = await httpJson(http.baseUrl, 'GET', '/api/calendar/sources', { token: tokenB });
    assert.equal(crossSources.status, 200);
    assert.equal((crossSources.json.sources || []).length, 0);
    const crossSync = await httpJson(http.baseUrl, 'POST', `/api/calendar/sources/${sourceId}/sync`, {
      token: tokenB,
      body: { full: true },
    });
    assert.ok(crossSync.status === 404 || crossSync.status === 403 || crossSync.json?.ok === false);

    // 5) Backend restart — projection survives in PG; day view must show exactly one external create.
    await http.close();
    http = await startHttpServer({
      pool: pg.pool,
      authKit: authState.authKit,
      fixedPort,
    });
    assert.equal(http.baseUrl, `http://127.0.0.1:${fixedPort}`);
    await page.waitForTimeout(1200);
    const refreshCal = page.getByRole('button', { name: /캘린더|Calendar/i }).first();
    if (await refreshCal.count()) await refreshCal.click().catch(() => {});
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => {
      const text = document.body ? document.body.innerText : '';
      return /Google timed meeting|Google external create|Internal meeting P4|Google Calendar:connected/i.test(text);
    }, null, { timeout: 30_000 });

    // API authority after backend restart: exactly one occurrence for the created event.
    const unifiedAfterBackend = await httpJson(
      http.baseUrl,
      'GET',
      `/api/calendar/unified?from=${encodeURIComponent(rangeStart)}&to=${encodeURIComponent(rangeEnd)}`,
      { token },
    );
    assert.equal(unifiedAfterBackend.status, 200);
    const extAfterBackend = (unifiedAfterBackend.json.entries || []).filter((e) => /Google external create/i.test(e.title || ''));
    assert.equal(
      extAfterBackend.length,
      1,
      `after backend restart API must have exactly 1 external create, got ${extAfterBackend.length}: ${JSON.stringify(extAfterBackend)}`,
    );
    if (createdProviderEventId) {
      assert.equal(extAfterBackend[0].providerEventId, createdProviderEventId);
    }
    const occDbAfterBackend = await pg.pool.query(
      `select count(*)::int as n from calendar_occurrences
       where workspace_id = $1 and source_id = $2 and title = 'Google external create'`,
      [workspaceId, googleSource.id],
    );
    assert.equal(occDbAfterBackend.rows[0].n, 1);

    await switchCalendarView(page, '일', '.day-schedule');
    assert.ok(await page.locator('.day-schedule').count(), 'day schedule must render after backend restart');
    // Count day-view event leaves only (hour-row buttons also inherit child textContent — do not count parents).
    const dayExtCount = await page.evaluate(() => {
      const root = document.querySelector('.day-schedule');
      if (!root) return -1;
      const leaves = Array.from(root.querySelectorAll('.day-hours em, .day-all-day'));
      return leaves.filter((n) => /Google external create/i.test(n.textContent || '')).length;
    });
    assert.equal(dayExtCount, 1, `day view after backend restart must show exactly 1 Google external create, got ${dayExtCount}`);
    await page.screenshot({ path: shots.afterBackendRestart, fullPage: true });

    // 6) Desktop restart — secure session should rehydrate without login wall
    await closeApp(electronApp);
    electronApp = null;
    electronApp = await launchApp(http.baseUrl);
    page = await electronApp.firstWindow();
    await page.waitForTimeout(2000);
    const loginCount = await page.locator('button:has-text("AuthKit으로 계속하기")').count();
    if (loginCount > 0) {
      // Fallback only if session store was wiped: re-auth once
      await page.locator('button:has-text("AuthKit으로 계속하기")').click();
      await page.waitForTimeout(400);
      const pending2 = authState.getLastStart();
      assert.ok(pending2);
      await receiveAuthUrl(electronApp, `agent-calendar://auth/callback?code=p4r&state=${encodeURIComponent(pending2.state)}`);
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some((b) => /AuthKit으로 계속하기/.test(b.textContent || '')), null, { timeout: 25_000 });
    }
    const calNav2 = page.getByRole('button', { name: /캘린더|Calendar/i }).first();
    if (await calNav2.count()) await calNav2.click().catch(() => {});
    await page.waitForSelector('[data-testid="unified-calendar"]', { timeout: 30_000 });
    await page.waitForFunction(() => {
      const text = document.body ? document.body.innerText : '';
      return /Google Calendar 연결됨|커버리지 완료|Google timed|Google external|Internal meeting|connected/i.test(text);
    }, null, { timeout: 45_000 });
    // Rehydrate only — do not full-resync (fake provider memory is empty after backend restart;
    // local projection in PG is the restart-survival source of truth).
    const todayBtn2 = page.getByRole('button', { name: '오늘' });
    if (await todayBtn2.count()) await todayBtn2.click().catch(() => {});
    // Month view shows more concurrent pills than week (week caps per-day list).
    await switchCalendarView(page, '월', '.month-grid');
    assert.ok(await page.locator('.month-grid').count(), 'month grid must render after Desktop restart');
    const rehydrated = await page.locator('body').innerText();
    // UI must show Google + internal after restart (month cells may truncate dense days).
    assert.match(rehydrated, /Google timed meeting|Google daily standup|Google all-day focus|Google external create/i);
    assert.match(rehydrated, /Internal meeting P4|Internal/i);
    assert.match(rehydrated, /Google Calendar 연결됨|connected/i);
    // Authoritative projection survival: unified API after Desktop restart.
    const unifiedAfterDesktop = await httpJson(
      http.baseUrl,
      'GET',
      `/api/calendar/unified?from=${encodeURIComponent(rangeStart)}&to=${encodeURIComponent(rangeEnd)}`,
      { token },
    );
    assert.equal(unifiedAfterDesktop.status, 200);
    const titles = (unifiedAfterDesktop.json.entries || []).map((e) => e.title);
    assert.ok(titles.some((t) => /Google timed meeting|Google external create|Google daily|Google all-day/i.test(t)), JSON.stringify(titles));
    assert.ok(titles.some((t) => /Internal meeting P4/i.test(t)), JSON.stringify(titles));
    assert.ok(titles.some((t) => /Agent result: Phase4/i.test(t)), JSON.stringify(titles));
    const extAfterDesktop = (unifiedAfterDesktop.json.entries || []).filter((e) => /Google external create/i.test(e.title || ''));
    assert.equal(
      extAfterDesktop.length,
      1,
      `after desktop restart API must have exactly 1 external create, got ${extAfterDesktop.length}: ${JSON.stringify(extAfterDesktop)}`,
    );
    if (createdProviderEventId) {
      assert.equal(extAfterDesktop[0].providerEventId, createdProviderEventId);
    }
    // Coverage statements must remain separated after restart
    const cov = unifiedAfterDesktop.json.coverage || [];
    assert.ok(cov.some((c) => c.sourceKind === 'internal' && c.eventCount >= 1));
    assert.ok(cov.some((c) => c.sourceKind === 'agent_work' && c.eventCount >= 1));
    // Month view: at most one pill text for the create (cells may truncate label).
    const monthExtMentions = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const matches = text.match(/Google external create/gi);
      return matches ? matches.length : 0;
    });
    assert.ok(monthExtMentions >= 1, 'month view should mention external create at least once');
    assert.ok(monthExtMentions <= 2, `month view must not list many external create clones, got ${monthExtMentions}`);
    await page.screenshot({ path: shots.afterDesktopRestart, fullPage: true });

    for (const [name, filePath] of Object.entries(shots)) {
      assert.ok(fs.existsSync(filePath), `missing screenshot ${name}`);
      assert.ok(fs.statSync(filePath).size > 5000, `screenshot ${name} too small`);
    }
    const screenshotHashes = Object.fromEntries(
      Object.entries(shots).map(([k, p]) => [k, sha256File(p)]),
    );
    // Screenshots must not all be identical blank frames. Stable restart may match a prior
    // month-view frame when projection rehydrates without visual change (honest evidence).
    const uniqueHashes = new Set(Object.values(screenshotHashes));
    assert.ok(uniqueHashes.size >= 4, `expected ≥4 distinct screenshots, got ${uniqueHashes.size}: ${JSON.stringify(screenshotHashes)}`);
    assert.notEqual(screenshotHashes.afterBackendRestart, screenshotHashes.externalCreate, 'backend restart day view must differ from month external create');

    results.status = 'verified';
    results.durationMs = Date.now() - started;
    results.workspaceId = workspaceId;
    results.coverageBeforeSync = coverageBefore;
    results.screenshotHashes = screenshotHashes;
    results.uniqueScreenshotCount = uniqueHashes.size;
    results.mutationReceipts = receipts.rows.map((r) => ({ status: r.status, operation: r.operation }));
    results.isolation = { workspaceBSources: (crossSources.json.sources || []).length, crossSyncStatus: crossSync.status };
    results.liveGoogleOAuth = 'not exercised (fail-closed production path covered in backend tests)';
    results.gatesNote = 'full monorepo gates recorded after this ETE in plan/evidence';
    results.personalScreenshotInspection = 'pending-agent-visual-pass';

    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, ...results }, null, 2));
    exitCode = 0;
  } catch (error) {
    exitCode = 1;
    results.status = 'failed';
    results.error = error && error.stack ? error.stack : String(error);
    results.durationMs = Date.now() - started;
    try {
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, `${JSON.stringify(results, null, 2)}\n`);
    } catch { /* ignore */ }
    console.error(error);
  } finally {
    clearTimeout(hard);
    // Await cleanup, then set exitCode for a normal process end (do not call process.exit
    // here — it races with pending IO and breaks shell PIPESTATUS / supervisors).
    await cleanup({
      electronApp,
      http,
      pg,
      runtime: http && http.runtime ? http.runtime : null,
    });
  }
  process.exitCode = exitCode;
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
