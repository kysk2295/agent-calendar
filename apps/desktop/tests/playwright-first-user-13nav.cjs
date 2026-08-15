'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DESKTOP_ROOT,
  closePackagedApp,
  mergeEvidence,
  openPackagedApp,
  screenshot,
  visibleCopy,
} = require('./playwright-first-user-folderless.cjs');

const NAVIGATION_DESTINATIONS = [
  ['calendar', '캘린더', '캘린더'],
  ['agents', '에이전트', '에이전트'],
  ['automation', '자동화', '자동화'],
  ['today', '오늘', '오늘'],
  ['next7', '다음 7일', '다음 7일'],
  ['tasks', '기본함', '기본함'],
  ['mail', '메일함', '메일함'],
  ['kanban', '칸반 보드', '칸반 보드'],
  ['wiki', '위키', '위키'],
  ['review', '주간 회고', '주간 회고'],
  ['diary', '일기', '일기'],
  ['runner', 'Runner 설정', 'Runner 설정'],
  ['widgets', '위젯', '위젯'],
];

const SHELL_CONTROL_COUNT = {
  navigationDestinationIds: NAVIGATION_DESTINATIONS.length,
  separateSearchControl: true,
};

function sourceNavigationIds(source, declaration) {
  const block = source.match(new RegExp(`const ${declaration}:[\\s\\S]*?\\n\\];`));
  assert.ok(block, `${declaration} declaration is missing`);
  return [...block[0].matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1]);
}

function staticContract() {
  const source = fs.readFileSync(path.join(DESKTOP_ROOT, 'src', 'App.tsx'), 'utf8');
  const actual = [
    ...sourceNavigationIds(source, 'primaryNavItems'),
    ...sourceNavigationIds(source, 'secondaryNavItems'),
  ];
  assert.deepEqual(actual, NAVIGATION_DESTINATIONS.map(([id]) => id));
  assert.match(source, /className="sidebar-search"/);
  assert.match(source, /openScreen\('search'\)/);
  console.log(JSON.stringify({
    ok: true,
    destinationIds: actual,
    shellControlCount: SHELL_CONTROL_COUNT,
  }));
}

async function openSecondaryNavigation(page) {
  const details = page.locator('details.nav-more');
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator('summary').click();
  }
}

async function captureControl(page, id, label, title) {
  if (id === 'search') {
    await page.locator('.sidebar-search').click();
  } else {
    const button = page.locator('.nav-item').filter({ hasText: label }).first();
    await button.click();
    await page.locator('.nav-item[data-active="true"]').filter({ hasText: label }).first().waitFor();
    assert.equal(await button.getAttribute('data-active'), 'true');
  }
  const heading = page.locator('.screen-heading strong');
  await heading.filter({ hasText: title }).waitFor();
  assert.equal(String(await heading.textContent() || '').trim(), title);
  return {
    dataScreen: id,
    title,
    emptyOrStatusCopy: await visibleCopy(page),
    screenshot: await screenshot(page, `nav-${id}.png`),
  };
}

async function main() {
  if (process.argv.includes('--static-contract')) {
    staticContract();
    return 0;
  }
  const context = await openPackagedApp('all-nav');
  if (context.exitCode !== 0) return context.exitCode;
  try {
    await openSecondaryNavigation(context.page);
    const labels = await context.page.locator(
      '.nav-primary .nav-item, .nav-more-items .nav-item',
    ).allTextContents();
    assert.deepEqual(
      labels.map((label) => label.trim()),
      NAVIGATION_DESTINATIONS.map(([, label]) => label),
      'packaged sidebar destination order changed',
    );

    const surfaces = [];
    surfaces.push(await captureControl(context.page, 'search', '검색', '검색'));
    for (const [id, label, title] of NAVIGATION_DESTINATIONS) {
      surfaces.push(await captureControl(context.page, id, label, title));
    }
    const receipt = {
      status: 'PASS',
      packagedApp: true,
      rendererUrl: context.page.url(),
      productionGateway: 'https://hermes-os-production-e174.up.railway.app',
      domSidebarControlOrder: ['search', ...NAVIGATION_DESTINATIONS.map(([id]) => id)],
      shellControlCount: SHELL_CONTROL_COUNT,
      surfaces,
    };
    mergeEvidence('all-nav', receipt);
    console.log(JSON.stringify(receipt));
    return 0;
  } finally {
    await closePackagedApp(context);
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
