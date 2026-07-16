const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const auditDir = process.env.HERMES_AUTOMATION_AUDIT_DIR || '';
const viewportWidth = Number(process.env.HERMES_AUTOMATION_VIEWPORT_WIDTH || 1280);
const screenshotOnly = process.env.HERMES_AUTOMATION_SCREENSHOT_ONLY === '1';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: 800 } });
  const mutations = [];
  let rejectNextPatch = false;
  let jobs = [{
    id: 'hermes-cron:weekly-brief',
    name: '주간 일정 브리프',
    goal: '다음 주 일정과 빈 시간을 정리한다.',
    agent: 'default',
    enabled: true,
    scheduleDisplay: '0 9 * * 1',
    status: 'active',
    source: 'hermes-cli-cron',
    lastRunAt: '2026-07-13T00:00:00.000Z',
    nextRunAt: '2026-07-20T00:00:00.000Z',
    lastStatus: 'completed',
  }];

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }

    if (url.pathname === '/api/scheduler/jobs') {
      await route.fulfill({ json: { ok: true, jobs } });
      return;
    }

    if (url.pathname === '/api/scheduler/jobs/hermes-cron%3Aweekly-brief') {
      const body = request.postData() ? JSON.parse(request.postData()) : null;
      mutations.push({ method: request.method(), body });
      if (request.method() === 'PATCH' && rejectNextPatch) {
        rejectNextPatch = false;
        await route.fulfill({ status: 503, json: { error: 'runtime_unavailable', message: 'Hermes 연결을 확인해 주세요.' } });
        return;
      }
      if (request.method() === 'PATCH') {
        jobs = jobs.map((job) => ({ ...job, ...body, agent: body.agentId || job.agent, scheduleDisplay: body.schedule || job.scheduleDisplay, status: body.enabled === false ? 'paused' : body.enabled === true ? 'active' : job.status }));
      }
      if (request.method() === 'DELETE') jobs = [];
      await route.fulfill({ json: { ok: true, jobs } });
      return;
    }

    await route.fulfill({ json: {
      ok: true,
      tasks: [], events: [], agents: [], runs: [], documents: [], messages: [], jobs: [],
      missions: [], sessions: [], reports: [], channels: [], tools: [], items: [], commands: [],
      daemon: { running: true, lastRun: null, lastError: null },
      settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
      uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
    } });
  });

  // Given: one active Hermes cron job is connected.
  await page.goto(target);

  // When: the user opens the dedicated sidebar tab and edits the job.
  await page.locator('.nav-item').filter({ hasText: 'Hermes 자동화' }).click();
  if (auditDir) {
    await fs.mkdir(auditDir, { recursive: true });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(auditDir, `hermes-automation-${viewportWidth}.png`) });
  }
  if (screenshotOnly) {
    await browser.close();
    console.log(JSON.stringify({ ok: true, screenshotOnly, viewportWidth }, null, 2));
    return;
  }
  await page.getByLabel('자동화 이름').fill('월요일 일정 브리프');
  await page.getByLabel('자동화 목표').fill('이번 주 일정과 빈 시간을 정리한다.');
  await page.getByLabel('담당 프로필').fill('calendar');
  await page.getByLabel('실행 일정').fill('0 8 * * 1');
  await page.getByRole('button', { name: '변경사항 저장' }).click();
  await page.getByText('변경사항을 저장했습니다.').waitFor();

  // Then: edit, pause/resume, and confirmed delete all use scheduler mutations.
  await page.getByRole('button', { name: '일시정지' }).click();
  await page.getByText('자동화를 일시정지했습니다.').waitFor();
  await page.getByRole('button', { name: '다시 활성화' }).click();
  await page.getByText('자동화를 다시 활성화했습니다.').waitFor();
  await page.getByRole('button', { name: '자동화 삭제' }).click();
  assert.equal(await page.getByRole('button', { name: '삭제 확인' }).isVisible(), true);
  if (auditDir) {
    await page.locator('.hermes-automation-delete-confirm').waitFor();
    await page.evaluate(() => document.body.offsetHeight);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(auditDir, `hermes-automation-delete-confirm-${viewportWidth}.png`) });
  }
  await page.getByRole('button', { name: '삭제 확인' }).click();
  await page.getByText('연결된 Hermes 자동화가 없습니다.').waitFor();

  assert.deepEqual(mutations, [
    { method: 'PATCH', body: { name: '월요일 일정 브리프', goal: '이번 주 일정과 빈 시간을 정리한다.', agentId: 'calendar', schedule: '0 8 * * 1' } },
    { method: 'PATCH', body: { enabled: false } },
    { method: 'PATCH', body: { enabled: true } },
    { method: 'DELETE', body: null },
  ]);
  assert.match(await page.locator('.screen-heading').textContent() || '', /Hermes 자동화/);

  // Given: the runtime rejects an edit request.
  jobs = [{ id: 'hermes-cron:weekly-brief', name: '주간 일정 브리프', goal: '원래 목표', agent: 'default', enabled: true, scheduleDisplay: '0 9 * * 1', status: 'active', source: 'hermes-cli-cron' }];
  rejectNextPatch = true;
  await page.reload();

  // When: the user edits and saves from the automation tab.
  await page.locator('.nav-item').filter({ hasText: 'Hermes 자동화' }).click();
  await page.getByLabel('자동화 목표').fill('실패해도 보존할 편집값');
  await page.getByRole('button', { name: '변경사항 저장' }).click();

  // Then: the server error is visible and the edit draft is preserved.
  await page.getByText('Hermes 연결을 확인해 주세요.').waitFor();
  assert.equal(await page.getByLabel('자동화 목표').inputValue(), '실패해도 보존할 편집값');
  assert.equal(mutations.at(-1).method, 'PATCH');
  if (auditDir) {
    await page.locator('.hermes-automations-layout').waitFor();
    await page.evaluate(() => document.body.offsetHeight);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(auditDir, `hermes-automation-error-${viewportWidth}.png`) });
  }

  await browser.close();
  console.log(JSON.stringify({ ok: true, mutations }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
