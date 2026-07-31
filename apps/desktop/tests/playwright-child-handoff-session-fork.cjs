const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const evidenceDir = path.resolve(
  process.env.EVIDENCE_DIR
    || '.omo/evidence/production-readiness-completion/task-12/playwright',
);
const statePath = path.join(evidenceDir, 'fixture-db-state.json');
const fixtureServerPath = path.resolve(
  'apps/desktop/tests/support/child-handoff-session-fixture-server.cjs',
);

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function startFixture(port = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixtureServerPath, statePath, String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Fixture server readiness timed out: ${stderr}`));
    }, 10_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/).find(Boolean);
      if (!line) return;
      try {
        const ready = JSON.parse(line);
        if (ready.ready !== true) return;
        clearTimeout(timeout);
        resolve({ child, port: ready.port, pid: ready.pid, stderr: () => stderr });
      } catch {
        return;
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code && !stdout) {
        clearTimeout(timeout);
        reject(new Error(`Fixture server exited ${code}: ${stderr}`));
      }
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

async function capture(locator, name) {
  await locator.scrollIntoViewIfNeeded();
  await locator.page().evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await locator.screenshot({
    path: path.join(evidenceDir, `${name}.png`),
    animations: 'disabled',
  });
}

async function openWork(page) {
  await page.goto(page.url() || 'about:blank');
}

async function enterWorkConversation(page, viteUrl) {
  await page.goto(viteUrl);
  await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
  await page.locator('.agent-control-room').waitFor();
  await page.locator('.agent-running-card', { hasText: 'Root ownership audit' }).click();
  await page.locator('.agent-work-conversation').waitFor();
  const panel = page.locator('[data-testid="agent-work-delegation"]');
  await panel.locator('summary').click();
  await panel.waitFor();
  return panel;
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  for (const name of fs.readdirSync(evidenceDir)) {
    if (/^\d{2}-.+\.png$/.test(name)) fs.unlinkSync(path.join(evidenceDir, name));
  }
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  const lifecycle = [];
  const { server: vite, url: viteUrl } = await startVite();
  let fixture = await startFixture();
  lifecycle.push({ event: 'fixture_started', pid: fixture.pid, port: fixture.port });
  const fixturePort = fixture.port;
  const fixtureUrl = `http://127.0.0.1:${fixture.port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const theme = process.env.AGENT_CALENDAR_E2E_THEME === 'dark' ? 'dark' : 'default';
  await page.addInitScript(({ selectedTheme, baseUrl }) => {
    const releaseStatus = {
      supported: false,
      phase: 'unsupported',
      currentVersion: '0.1.0',
      availableVersion: null,
      progressPercent: null,
      checkedAt: null,
      message: 'fixture',
    };
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: baseUrl,
        hasApiToken: false,
        hasSession: true,
        theme: selectedTheme,
        authProfile: {
          provider: 'authkit',
          id: 'task12-owner',
          email: 'task12@example.test',
          name: 'Task 12 Owner',
          updatedAt: '2026-07-26T06:00:00.000Z',
        },
        session: {
          signedIn: true,
          workspaceId: 'workspace-task12',
          userId: 'task12-owner',
          role: 'owner',
        },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      }),
      getSessionStatus: async () => ({
        signedIn: true,
        sessionId: 'desktop-session-task12',
        userId: 'task12-owner',
        workspaceId: 'workspace-task12',
        role: 'owner',
        email: 'task12@example.test',
        displayName: 'Task 12 Owner',
        accessExpiresAt: null,
      }),
      getHermesConnection: async () => ({ baseUrl, credential: '' }),
      getDesktopReleaseStatus: async () => releaseStatus,
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
  }, { selectedTheme: theme, baseUrl: fixtureUrl });

  try {
    let panel = await enterWorkConversation(page, viteUrl);
    assert.match(await panel.textContent() || '', /Root agent stays root-agent/);
    await capture(panel, '01-root-delegated-work');

    await page.getByLabel('Child receiver Agent ID').fill('child-agent');
    await page.getByLabel('Child handoff goal').fill('Inspect production readiness evidence.');
    await page.getByLabel('Child requested grants').fill('tool:workspace.read tool:mail.send');
    await page.getByLabel('Child denied grants').fill('tool:mail.send');
    await page.getByLabel('Child max runs').fill('2');
    await page.getByLabel('Child max minutes').fill('30');
    await page.getByLabel('Child max cost').fill('3');
    await page.getByRole('button', { name: 'Hand off bounded child' }).click();
    await page.getByRole('status').filter({ hasText: 'Bounded child handoff 완료' }).waitFor();
    const childRow = panel.locator('.agent-work-handoff-row', { hasText: 'root-agent → child-agent' });
    await childRow.waitFor();
    assert.match(await childRow.textContent() || '', /root-agent → child-agent/);
    assert.match(await childRow.textContent() || '', /tool:workspace.read/);
    assert.match(await childRow.textContent() || '', /tool:mail.send/);
    assert.match(await childRow.textContent() || '', /2 runs · 30 min · \$3.00/);
    await capture(panel, '02-child-lineage-grants-budget');

    await page.getByLabel('Child receiver Agent ID').fill('root-agent');
    await page.getByLabel('Child handoff goal').fill('Attempt a cycle.');
    await page.getByRole('button', { name: 'Hand off bounded child' }).click();
    await page.getByRole('alert').filter({ hasText: 'cycle' }).waitFor();
    const afterCycle = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(afterCycle.handoffs.length, 1);
    await capture(panel, '03-cycle-rejection');

    await page.getByLabel('Child receiver Agent ID').fill('quota-agent');
    await page.getByLabel('Child handoff goal').fill('Attempt excess fan-out.');
    await page.getByRole('button', { name: 'Hand off bounded child' }).click();
    await page.getByRole('alert').filter({ hasText: 'fan-out limit exceeded' }).waitFor();
    const afterQuota = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(afterQuota.handoffs.length, 1);
    await capture(panel, '04-quota-rejection');

    await page.getByRole('button', { name: 'Cancel child child-agent' }).click();
    await page.getByRole('status').filter({ hasText: 'Child cancellation 완료' }).waitFor();
    await page.reload();
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await page.locator('.agent-running-card', { hasText: 'Root ownership audit' }).click();
    panel = page.locator('[data-testid="agent-work-delegation"]');
    await panel.locator('summary').click();
    await panel.locator('.agent-work-handoff-row[data-status="cancelled"]').waitFor();
    assert.match(await page.locator('.agent-work-header').textContent() || '', /Root Agent|root-agent/);

    await stopChild(fixture.child);
    lifecycle.push({ event: 'fixture_stopped_for_restart', pid: fixture.pid, port: fixture.port });
    fixture = await startFixture(fixturePort);
    lifecycle.push({ event: 'fixture_restarted', pid: fixture.pid, port: fixture.port });
    assert.notEqual(lifecycle[0].pid, fixture.pid);
    await page.reload();
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await page.locator('.agent-running-card', { hasText: 'Root ownership audit' }).click();
    panel = page.locator('[data-testid="agent-work-delegation"]');
    await panel.locator('summary').click();
    await panel.locator('.agent-work-handoff-row[data-status="cancelled"]').waitFor();
    const restartedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(restartedState.restartCount, 1);
    assert.equal(restartedState.rootMission.agentId, 'root-agent');
    assert.equal(restartedState.handoffs[0].status, 'cancelled');
    await capture(panel, '05-cancelled-after-process-restart');
    const lifecyclePage = await browser.newPage({ viewport: { width: 900, height: 620 } });
    await lifecyclePage.setContent(`
      <main style="font-family: ui-monospace, SFMono-Regular, monospace; color: #f4f4f5; background: #09090b; min-height: 100vh; padding: 32px;">
        <h1 style="font: 700 22px system-ui; margin: 0 0 8px;">QA process lifecycle receipt</h1>
        <p style="color: #a1a1aa; margin: 0 0 24px;">Persisted fixture state on port ${fixturePort}</p>
        <ol style="display: grid; gap: 12px; margin: 0; padding: 0; list-style: none;">
          ${lifecycle.map((item) => `<li style="padding: 14px; border: 1px solid #3f3f46; background: #18181b;"><strong>${item.event}</strong><br><span style="color:#a1a1aa">pid ${item.pid} · port ${item.port}</span></li>`).join('')}
        </ol>
        <p style="margin-top: 24px; color: #86efac;">restartCount ${restartedState.restartCount} · root-agent retained · handoff cancelled retained</p>
      </main>
    `);
    await lifecyclePage.screenshot({
      path: path.join(evidenceDir, '06-process-restart-receipt.png'),
      animations: 'disabled',
      fullPage: true,
    });
    await lifecyclePage.close();

    await page.getByLabel('Provider session ID').fill('psess-missing');
    await page.getByLabel('Provider transition instruction').fill('Try a missing provider session.');
    await page.getByRole('button', { name: 'Rebind selected session' }).click();
    await page.getByRole('alert').filter({ hasText: 'not found' }).waitFor();
    const missingState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(missingState.transitions.length, 0);
    assert.equal(missingState.jobs.filter((job) => job.kind === 'provider_transition').length, 0);
    await capture(panel, '07-missing-session-failure');

    await page.getByLabel('Provider session ID').fill('psess-ready');
    await page.getByLabel('Provider transition instruction').fill('Explicitly rebind to the ready session.');
    await page.getByRole('button', { name: 'Rebind selected session' }).click();
    await page.getByRole('status').filter({ hasText: 'Provider rebind 완료' }).waitFor();
    assert.match(await panel.textContent() || '', /Active pointer: psess-ready/);
    assert.match(await page.getByLabel('Provider session transition history').textContent() || '', /rebindpsess-current → psess-ready/);
    await capture(panel, '08-explicit-rebind');

    const beforeFork = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    await page.getByLabel('Provider session ID').fill('psess-ready');
    await page.getByLabel('Provider transition instruction').fill('Fork one isolated continuation.');
    await page.getByRole('button', { name: 'Fork selected session' }).click();
    await page.getByRole('status').filter({ hasText: 'Provider fork 완료' }).waitFor();
    const afterFork = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(afterFork.transitions.length, beforeFork.transitions.length + 1);
    assert.equal(afterFork.jobs.length, beforeFork.jobs.length + 1);
    assert.equal(afterFork.transitions.at(-1).action, 'fork');
    assert.equal(afterFork.providerSessions.at(-1).lineage[0], 'psess-ready');
    await capture(panel, '09-rebind-and-single-fork');

    const comparisonText = await panel.locator('.agent-work-comparison-grid').textContent() || '';
    assert.match(comparisonText, /72s/);
    assert.match(comparisonText, /\$1.25/);
    assert.match(comparisonText, /Evidence2/);
    await page.getByRole('button', { name: 'Adopt result codex' }).click();
    await page.getByRole('status').filter({ hasText: 'Comparison result adoption 완료' }).waitFor();
    const adoptedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(adoptedState.comparison.currentResultReportId, 'report-codex');
    assert.equal(adoptedState.comparison.outcomes.length, 2);
    assert.equal(adoptedState.comparison.outcomes[0].summary, 'Fast result with two supporting artifacts.');
    assert.match(await panel.textContent() || '', /codexCurrent result/);
    await capture(panel, '10-comparison-adopted-pointer');

    const expectedFailureConsoleErrors = consoleErrors.filter((message) => (
      message.includes('status of 409')
      || message.includes('status of 404')
    ));
    const unexpectedConsoleErrors = consoleErrors.filter((message) => (
      !message.includes('status of 409')
      && !message.includes('status of 404')
    ));
    const observables = {
      theme,
      rootOwnership: {
        dom: 'root-agent',
        backend: adoptedState.rootMission.agentId,
      },
      handoff: {
        domStatus: await panel.locator('.agent-work-handoff-row').first().getAttribute('data-status'),
        backendStatus: adoptedState.handoffs[0].status,
        lineage: adoptedState.handoffs[0].lineage,
        effectiveGrants: adoptedState.handoffs[0].effectiveGrants,
        effectiveBudget: adoptedState.handoffs[0].effectiveBudget,
      },
      restartCount: adoptedState.restartCount,
      provider: {
        activeProviderSessionId: adoptedState.activeProviderSessionId,
        transitions: adoptedState.transitions,
        transitionJobs: adoptedState.jobs.filter((job) => job.kind === 'provider_transition'),
      },
      comparison: {
        currentResultReportId: adoptedState.comparison.currentResultReportId,
        immutableOutcomeCount: adoptedState.comparison.outcomes.length,
        adoptionCount: adoptedState.comparison.adoptions.length,
      },
      expectedFailureConsoleErrors,
      unexpectedConsoleErrors,
    };
    assert.equal(observables.rootOwnership.dom, observables.rootOwnership.backend);
    assert.equal(observables.handoff.domStatus, observables.handoff.backendStatus);
    assert.equal(observables.provider.transitions.length, observables.provider.transitionJobs.length);
    assert.equal(expectedFailureConsoleErrors.length, 3);
    assert.deepEqual(unexpectedConsoleErrors, []);
    fs.writeFileSync(
      path.join(evidenceDir, 'backend-db-dom-observables.json'),
      `${JSON.stringify(observables, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(evidenceDir, 'process-lifecycle.json'),
      `${JSON.stringify(lifecycle, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      theme,
      screenshots: 10,
      restartCount: adoptedState.restartCount,
      handoffs: adoptedState.handoffs.length,
      transitions: adoptedState.transitions.length,
      adoptions: adoptedState.comparison.adoptions.length,
    }, null, 2)}\n`);
  } finally {
    await browser.close();
    await stopChild(fixture.child);
    lifecycle.push({ event: 'fixture_stopped_final', pid: fixture.pid, port: fixture.port });
    const viteCleanup = await vite.close();
    fs.writeFileSync(
      path.join(evidenceDir, 'cleanup-receipt.json'),
      `${JSON.stringify({
        fixturePid: fixture.pid,
        fixturePort,
        fixtureExitCode: fixture.child.exitCode,
        viteClosed: viteCleanup === undefined,
        lifecycle,
      }, null, 2)}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
