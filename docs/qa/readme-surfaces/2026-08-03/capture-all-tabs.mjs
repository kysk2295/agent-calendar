import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../..');
const outputDir = path.join(root, 'docs/product/surfaces');
const cdpUrl = process.env.QA_CDP_URL || 'http://127.0.0.1:9228';

const surfaces = [
  { label: '캘린더', file: '01-calendar.png' },
  { label: '에이전트', file: '02-agents.png' },
  { label: '자동화', file: '03-automation.png' },
  { label: '오늘', file: '04-today.png', workspace: true },
  { label: '다음 7일', file: '05-next-seven-days.png', workspace: true },
  { label: '기본함', name: /^기본함(?:\s+\d+)?$/, file: '06-inbox.png', workspace: true },
  { label: '메일함', file: '07-mail.png', workspace: true },
  { label: '칸반 보드', file: '08-kanban.png', workspace: true },
  { label: '위키', file: '09-wiki.png', workspace: true },
  { label: '주간 회고', file: '10-weekly-review.png', workspace: true },
  { label: '일기', file: '11-diary.png', workspace: true },
  { label: 'Runner 설정', file: '12-runner.png', workspace: true },
  { label: '위젯', file: '13-widgets.png', workspace: true },
];

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => /Agent%20Calendar\.app\/Contents\/Resources\/app\.asar\/dist\/index\.html/.test(candidate.url()));

if (!page) {
  throw new Error('Packaged Agent Calendar page is not available');
}

page.setDefaultTimeout(5_000);

const packaged = await page.evaluate(async () => {
  const connection = await window.hermesDesktop?.getHermesConnection?.();
  const settings = await window.hermesDesktop?.getSettings?.();
  const response = await fetch(`${connection?.baseUrl || ''}/api/gateway-status`, {
    headers: {
      Accept: 'application/vnd.agent-calendar.client-v1+json, application/json',
      'x-agent-calendar-contract': 'client-v1',
      'x-agent-calendar-proxy-credential': connection?.credential || '',
    },
  });
  const gateway = await response.json().catch(() => ({}));
  return {
    signedIn: settings?.session?.signedIn === true,
    workspaceBound: Boolean(settings?.session?.workspaceId),
    packagedProxy: /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(connection?.baseUrl || ''),
    gateway: {
      status: response.status,
      mode: gateway?.mode || null,
      service: gateway?.service || null,
      sourceCommit: gateway?.sourceCommit || gateway?.source_commit || gateway?.buildCommit || null,
      deploymentId: gateway?.deploymentId || gateway?.deployment_id || null,
    },
  };
});

if (!page.url().startsWith('file:') || !packaged.signedIn || !packaged.workspaceBound || packaged.gateway.status !== 200) {
  throw new Error(`Packaged production precondition failed: ${JSON.stringify({ url: page.url(), packaged })}`);
}

async function revealWorkspaceNavigation() {
  const today = page.getByRole('button', { name: '오늘', exact: true });
  if (await today.isVisible().catch(() => false)) return;

  const toggle = page.getByText('작업공간', { exact: true }).first();
  if (!await toggle.count()) throw new Error('Workspace navigation toggle is missing');
  await toggle.click();
  await today.waitFor({ state: 'visible' });
}

async function applyPublicRedactions(surfaceLabel) {
  await page.evaluate((label) => {
    const profileName = document.querySelector('.profile strong');
    if (profileName) profileName.textContent = '사용자';

    if (label === 'Runner 설정') {
      const workspaceIdentity = document.querySelector('.runner-workspace-chip strong');
      if (workspaceIdentity) workspaceIdentity.textContent = 'workspace@example.com';
      const runnerFingerprint = document.querySelector('.runner-fp');
      if (runnerFingerprint) runnerFingerprint.textContent = 'Runner 공개 식별자는 캡처에서 가렸습니다.';
    }

    if (label === '일기') {
      const history = document.querySelector('.diary-screen aside');
      if (history) {
        const header = history.querySelector('header');
        for (const child of [...history.children]) {
          if (child !== header) child.remove();
        }
        const notice = document.createElement('p');
        notice.textContent = '개인 일기 내용은 공개 캡처에서 가렸습니다.';
        notice.style.margin = '32px';
        notice.style.color = 'var(--muted, #777)';
        history.append(notice);
      }
    }
  }, surfaceLabel);
}

await revealWorkspaceNavigation();

const captures = [];
for (const surface of surfaces) {
  console.error(`capture:start:${surface.label}`);
  await page.keyboard.press('Escape');
  if (surface.workspace) await revealWorkspaceNavigation();

  const target = typeof surface.name === 'object'
    ? page.getByRole('button', { name: surface.name }).first()
    : page.getByRole('button', { name: surface.label, exact: true }).first();
  if (!await target.count()) throw new Error(`Navigation target is missing: ${surface.label}`);
  await target.click({ timeout: 5_000 });
  await page.waitForTimeout(700);

  if (surface.label === '기본함') {
    const closeDetail = page.getByRole('button', { name: '작업 상세 닫기', exact: true });
    if (await closeDetail.isVisible().catch(() => false)) {
      await closeDetail.click();
      await page.waitForTimeout(250);
    }
  }

  await applyPublicRedactions(surface.label);

  const targetPath = path.join(outputDir, surface.file);
  await page.screenshot({
    path: targetPath,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    timeout: 5_000,
  });
  const bytes = await fs.readFile(targetPath);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
  }));
  const activeTitle = await page
    .locator('main h1, main h2, .page-title, .screen-title')
    .first()
    .textContent({ timeout: 2_000 })
    .catch(() => null);
  captures.push({
    label: surface.label,
    file: path.relative(root, targetPath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pixelWidth: bytes.readUInt32BE(16),
    pixelHeight: bytes.readUInt32BE(20),
    viewport,
    activeTitle: activeTitle?.trim() || surface.label,
  });
  console.error(`capture:done:${surface.label}:${surface.file}`);
}

const manifest = {
  capturedAt: new Date().toISOString(),
  source: {
    title: await page.title(),
    renderer: 'file://…/Agent Calendar.app/Contents/Resources/app.asar/dist/index.html',
    packaged: page.url().startsWith('file:') && page.url().includes('/app.asar/dist/index.html'),
    ...packaged,
  },
  redactions: [
    'account display name',
    'Workspace email address',
    'Runner public fingerprint',
    'personal diary history',
  ],
  expectedCount: surfaces.length,
  capturedCount: captures.length,
  captures,
};

await fs.writeFile(
  path.join(outputDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(JSON.stringify(manifest, null, 2));
await browser.close();
