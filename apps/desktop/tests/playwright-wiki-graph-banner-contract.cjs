const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { routeCompactWikiApis } = require('./wiki-graph-fixtures.cjs');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  await routeCompactWikiApis(page);

  await page.goto(target);
  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-svg-node');
  await page.getByRole('button', { name: '그래프 설정 열기' }).click();
  await page.getByLabel('선택 노트 로컬 그래프').check();
  await page.waitForSelector('.graph-banner-content[data-scope="local"][data-interactive="false"]');

  const contract = await page.evaluate(() => {
    const content = document.querySelector('.graph-banner-content');
    const overlay = document.querySelector('.graph-banner-overlay');
    const svg = document.querySelector('.wiki-graph-svg');
    const controls = document.querySelector('.wiki-graph-controls');
    const contentStyle = content ? getComputedStyle(content) : null;
    const svgStyle = svg ? getComputedStyle(svg) : null;
    return {
      hasWikiCanvas: content?.classList.contains('wiki-graph-canvas') ?? false,
      hasObsidianViewContentClass: content?.classList.contains('view-content') ?? false,
      overlayParentIsContent: overlay?.parentElement === content,
      overlayPrecedesGraph: Boolean(overlay && svg && overlay.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING),
      inactivePointerEvents: svgStyle?.pointerEvents || '',
      inactiveBorderColor: contentStyle?.borderTopColor || '',
      inactiveBorderWidth: contentStyle?.borderTopWidth || '',
      controlsExposeObsidianClass: controls?.classList.contains('graph-controls') ?? false,
      inactiveControlsClosed: controls?.classList.contains('is-close') ?? false,
      inactiveControlsDisplay: controls ? getComputedStyle(controls).display : '',
    };
  });
  assert.equal(contract.hasWikiCanvas, true, 'Graph Banner content should be the live wiki graph canvas');
  assert.equal(contract.hasObsidianViewContentClass, true, 'Graph Banner content should expose the original Obsidian view-content host class');
  assert.equal(contract.overlayParentIsContent, true, 'Graph Banner overlay should be inserted inside the graph content node');
  assert.equal(contract.overlayPrecedesGraph, true, 'Graph Banner overlay should sit before the rendered graph surface');
  assert.equal(contract.controlsExposeObsidianClass, true, 'Graph Banner controls should expose the original Obsidian graph-controls class');
  assert.equal(contract.inactiveControlsClosed, true, 'inactive Graph Banner controls should carry the original is-close class');
  assert.equal(contract.inactivePointerEvents, 'none', 'inactive Graph Banner content should lock graph pointer events');
  assert.equal(contract.inactiveBorderWidth, '2px', 'Graph Banner content should reserve the active border without layout shift');
  assert.equal(contract.inactiveControlsDisplay, 'none', 'inactive Graph Banner content should start with graph controls closed like the original plugin');
  assert.match(contract.inactiveBorderColor, /rgba?\(0, 0, 0, 0\)|transparent/);

  await page.locator('.graph-banner-overlay').dispatchEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
  await page.waitForSelector('.graph-banner-content[data-interactive="true"]');
  await page.waitForFunction(() => {
    const content = document.querySelector('.graph-banner-content');
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const accentColor = getComputedStyle(probe).color;
    probe.remove();
    return content ? getComputedStyle(content).borderTopColor === accentColor : false;
  });
  const activeContract = await page.evaluate(() => {
    const content = document.querySelector('.graph-banner-content');
    const contentStyle = content ? getComputedStyle(content) : null;
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const accentColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      activeBorderColor: contentStyle?.borderTopColor || '',
      activeBorderWidth: contentStyle?.borderTopWidth || '',
      accentColor,
      overlayCount: document.querySelectorAll('.graph-banner-overlay').length,
      overlayStillInsideContent: document.querySelector('.graph-banner-overlay')?.parentElement === content,
    };
  });
  assert.equal(activeContract.activeBorderWidth, '2px', 'active Graph Banner content should keep the original reserved border width');
  assert.equal(activeContract.activeBorderColor, activeContract.accentColor, 'active Graph Banner content should use the app accent like the original plugin uses --color-accent');
  assert.equal(activeContract.overlayCount, 1, 'active Graph Banner content should keep the original overlay node mounted');
  assert.equal(activeContract.overlayStillInsideContent, true, 'active Graph Banner overlay should stay inside the content host like the original plugin');
  assert.notEqual(
    await page.locator('.wiki-graph-svg').evaluate((svg) => getComputedStyle(svg).pointerEvents),
    'none',
    'active Graph Banner content should restore graph pointer events',
  );
  assert.notEqual(
    await page.locator('.wiki-graph-controls').evaluate((controls) => getComputedStyle(controls).display),
    'none',
    'active Graph Banner content should reopen graph controls',
  );

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
