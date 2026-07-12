const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { routeCompactWikiApis } = require('./wiki-graph-fixtures.cjs');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

async function graphNode(page, title) {
  const handle = await page.evaluateHandle((nodeTitle) => {
    const nodes = [...document.querySelectorAll('.wiki-svg-node')];
    return nodes.find((node) => node.querySelector('title')?.textContent === nodeTitle) || null;
  }, title);
  const element = handle.asElement();
  assert.notEqual(element, null, `${title} graph node should exist`);
  return element;
}

async function circlePoint(page, title) {
  return page.evaluate((nodeTitle) => {
    const node = [...document.querySelectorAll('.wiki-svg-node')]
      .find((entry) => entry.querySelector('title')?.textContent === nodeTitle);
    const circle = node?.querySelector('circle');
    return {
      x: Number(circle?.getAttribute('cx')),
      y: Number(circle?.getAttribute('cy')),
    };
  }, title);
}

async function edgePoint(page, edgeIndex) {
  return page.evaluate((index) => {
    const edge = document.querySelectorAll('.wiki-edge')[index];
    return {
      x1: Number(edge?.getAttribute('x1')),
      y1: Number(edge?.getAttribute('y1')),
      x2: Number(edge?.getAttribute('x2')),
      y2: Number(edge?.getAttribute('y2')),
    };
  }, edgeIndex);
}

async function graphNodeScreenCenter(page, title) {
  return page.evaluate((nodeTitle) => {
    const node = [...document.querySelectorAll('.wiki-svg-node')]
      .find((entry) => entry.querySelector('title')?.textContent === nodeTitle);
    const circle = node?.querySelector('circle');
    const box = circle?.getBoundingClientRect();
    if (!box) return null;
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  }, title);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  await routeCompactWikiApis(page);

  await page.goto(target);
  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-svg-node');
  await page.waitForFunction(() => document.querySelectorAll('.wiki-edge').length === 2);
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-interactive'), 'true');
  await page.getByRole('button', { name: '그래프 설정 열기' }).click();
  await page.waitForSelector('.wiki-graph-settings');
  assert.equal(await page.getByLabel('그래프 필터').count(), 1, 'settings should expose an Obsidian-style graph filter input');
  assert.equal(await page.getByLabel('고립 노드 표시').isChecked(), true);
  await page.getByLabel('고립 노드 표시').uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-svg-node').length === 3);
  await page.getByLabel('고립 노드 표시').check();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-svg-node').length === 4);
  await page.getByLabel('그래프 필터').fill('Linked alpha');
  await page.waitForFunction(() => document.querySelectorAll('.wiki-svg-node').length === 1);
  assert.match(await page.locator('.wiki-graph-panel > header').textContent() || '', /1개 노트/);
  await page.getByLabel('그래프 필터').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.wiki-svg-node').length === 4);
  assert.equal(await page.getByLabel('선택 노트 로컬 그래프').isChecked(), false);
  await page.getByLabel('선택 노트 로컬 그래프').check();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-svg-node').length === 3);
  assert.match(await page.locator('.wiki-graph-panel > header').textContent() || '', /로컬 그래프/);
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-scope'), 'local');
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-interactive'), 'false', 'Graph Banner local scope should start as a click-to-activate banner');
  assert.equal(await page.locator('.wiki-graph-banner-overlay').count(), 1, 'Graph Banner local scope should expose an activation overlay');
  assert.equal(
    await page.locator('.wiki-graph-svg').evaluate((svg) => getComputedStyle(svg).pointerEvents),
    'none',
    'Graph Banner inactive local scope should disable graph pointer events until the overlay activates it',
  );
  await page.locator('.wiki-graph-banner-overlay').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-interactive'), 'true', 'clicking the Graph Banner overlay should activate graph interactions');
  const localHub = await circlePoint(page, 'Hub strategy');
  const localAlpha = await circlePoint(page, 'Linked alpha');
  const localBeta = await circlePoint(page, 'Linked beta');
  const localCenter = { x: 480, y: 310 };
  const alphaVector = { x: localAlpha.x - localCenter.x, y: localAlpha.y - localCenter.y };
  const betaVector = { x: localBeta.x - localCenter.x, y: localBeta.y - localCenter.y };
  const alphaRadius = Math.hypot(alphaVector.x, alphaVector.y);
  const betaRadius = Math.hypot(betaVector.x, betaVector.y);
  const angleGap = Math.acos(Math.max(-1, Math.min(1, (alphaVector.x * betaVector.x + alphaVector.y * betaVector.y) / (alphaRadius * betaRadius))));
  assert.ok(Math.hypot(localHub.x - localCenter.x, localHub.y - localCenter.y) <= 1, `local graph algorithm should pin the selected note to the center, got ${JSON.stringify(localHub)}`);
  assert.ok(alphaRadius >= 95 && alphaRadius <= 150, `local graph algorithm should place Linked alpha on the neighbor ring, got radius ${alphaRadius}`);
  assert.ok(betaRadius >= 95 && betaRadius <= 150, `local graph algorithm should place Linked beta on the neighbor ring, got radius ${betaRadius}`);
  assert.ok(angleGap > 2.35, `local graph algorithm should spread the two 1-hop neighbors across the center, got angle gap ${angleGap}`);
  const localAlphaElement = await graphNode(page, 'Linked alpha');
  const localAlphaBox = await localAlphaElement.boundingBox();
  assert.notEqual(localAlphaBox, null);
  const localEdgeBeforeDrag = await edgePoint(page, 0);
  await page.mouse.move(localAlphaBox.x + localAlphaBox.width / 2, localAlphaBox.y + localAlphaBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(localAlphaBox.x + localAlphaBox.width / 2 + 70, localAlphaBox.y + localAlphaBox.height / 2 + 38);
  await page.mouse.up();
  const localAlphaAfterDrag = await circlePoint(page, 'Linked alpha');
  const localEdgeAfterDrag = await edgePoint(page, 0);
  assert.ok(Math.hypot(localAlphaAfterDrag.x - localAlpha.x, localAlphaAfterDrag.y - localAlpha.y) > 25, 'local graph drag should move the node in graph coordinates');
  assert.notDeepEqual(localEdgeAfterDrag, localEdgeBeforeDrag, 'local graph edge should follow the dragged node');
  assert.notEqual(
    await page.locator('.wiki-graph-svg').evaluate((svg) => getComputedStyle(svg).pointerEvents),
    'none',
    'Graph Banner active local scope should restore graph pointer events',
  );
  await page.mouse.click(20, 20);
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-interactive'), 'false', 'clicking outside the Graph Banner local graph should deactivate interactions');
  assert.equal(
    await page.locator('.wiki-graph-svg').evaluate((svg) => getComputedStyle(svg).pointerEvents),
    'none',
    'Graph Banner outside-click deactivation should disable graph pointer events again',
  );
  await page.locator('.wiki-graph-banner-overlay').dispatchEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-interactive'), 'true', 'local graph should be re-activatable after outside click');
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform') !== 'translate(0 0) scale(1)');
  assert.notEqual(await page.locator('.wiki-graph-viewport').getAttribute('transform'), 'translate(0 0) scale(1)');
  await page.getByLabel('선택 노트 로컬 그래프').uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-svg-node').length === 4);
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-scope'), 'global');
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-interactive'), 'true', 'global graph should remain immediately interactive');
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform') === 'translate(0 0) scale(1)');
  await page.getByLabel('선택 노트 로컬 그래프').check();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-svg-node').length === 3);
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-interactive'), 'false', 'Graph Banner local scope should recreate the inactive overlay when re-entered');
  assert.equal(await page.locator('.wiki-graph-banner-overlay').count(), 1, 'Graph Banner local scope should recreate the activation overlay when re-entered');
  await page.getByLabel('선택 노트 로컬 그래프').uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-svg-node').length === 4);
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform') === 'translate(0 0) scale(1)');
  await page.locator('.wiki-graph-settings input[type="range"]').nth(2).fill('0.9');
  assert.match(await page.locator('.wiki-graph-canvas').getAttribute('style') || '', /--wiki-edge-opacity: 0\.9/);
  await page.getByLabel('이름 표시').uncheck();
  await page.getByLabel('이름 표시').check();
  const beforeForce = await circlePoint(page, 'Daily isolate');
  await page.getByLabel('반발 힘').fill('1.5');
  await page.waitForTimeout(80);
  const afterForce = await circlePoint(page, 'Daily isolate');
  assert.ok(Math.hypot(afterForce.x - beforeForce.x, afterForce.y - beforeForce.y) > 20, 'repel force should change graph layout');
  await page.getByRole('button', { name: '그래프 설정 닫기' }).click();
  await page.waitForFunction(() => !document.querySelector('.wiki-graph-settings'));
  const compactGraphBox = await page.locator('.wiki-graph-canvas').boundingBox();
  assert.notEqual(compactGraphBox, null, 'graph canvas should have a compact width before focus mode');
  await page.getByRole('button', { name: '그래프 집중 보기' }).click();
  await page.waitForFunction(() => document.querySelector('.wiki-main')?.getAttribute('data-graph-focus') === 'true');
  const focusedGraphBox = await page.locator('.wiki-graph-canvas').boundingBox();
  assert.notEqual(focusedGraphBox, null, 'graph canvas should have a focused width after focus mode');
  assert.ok(focusedGraphBox.width > compactGraphBox.width + 100, `graph focus should give the canvas Obsidian-like room while preserving the Obsidian vault shell, got ${compactGraphBox.width} -> ${focusedGraphBox.width}`);
  assert.ok(focusedGraphBox.height > compactGraphBox.height + 90, `graph focus should reclaim vertical graph room like Obsidian, got ${compactGraphBox.height} -> ${focusedGraphBox.height}`);
  const focusedPanelStyle = await page.evaluate(() => {
    const panel = document.querySelector('.wiki-graph-panel');
    const style = panel ? getComputedStyle(panel) : null;
    return {
      borderTopLeftRadius: Number.parseFloat(style?.borderTopLeftRadius || ''),
      borderColor: style?.borderTopColor || '',
    };
  });
  assert.ok(focusedPanelStyle.borderTopLeftRadius <= 2, `graph focus should flatten the card frame like Obsidian, got radius ${focusedPanelStyle.borderTopLeftRadius}`);
  const focusedHeaderDisplay = await page.evaluate(() => getComputedStyle(document.querySelector('.wiki-graph-panel > header')).display);
  assert.equal(focusedHeaderDisplay, 'none', 'graph focus should hide the internal app header chrome like Obsidian graph view');
  const focusedChatFabDisplay = await page.evaluate(() => getComputedStyle(document.querySelector('.chat-fab')).display);
  assert.equal(focusedChatFabDisplay, 'none', 'graph focus should hide the app chat floating button like Obsidian graph view');
  const focusedSidebarDisplay = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).display);
  assert.equal(focusedSidebarDisplay, 'none', 'graph focus should hide the global app sidebar to match Obsidian graph view');
  const focusedTopbarDisplay = await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).display);
  assert.equal(focusedTopbarDisplay, 'none', 'graph focus should hide the global app topbar so the graph pane fills the window like Obsidian');
  const focusedContentInset = await page.evaluate(() => {
    const content = document.querySelector('.content');
    const style = content ? getComputedStyle(content) : null;
    return {
      paddingLeft: Number.parseFloat(style?.paddingLeft || ''),
      paddingTop: Number.parseFloat(style?.paddingTop || ''),
    };
  });
  assert.deepEqual(focusedContentInset, { paddingLeft: 0, paddingTop: 0 }, 'graph focus should remove the app content inset like Obsidian');
  const focusedShellBox = await page.locator('.wiki-obsidian-shell').boundingBox();
  const focusedTitlebarBox = await page.locator('.wiki-obsidian-titlebar').boundingBox();
  assert.notEqual(focusedShellBox, null, 'graph focus should keep an Obsidian-style vault shell inside the macOS window frame');
  assert.notEqual(focusedTitlebarBox, null, 'graph focus should keep an Obsidian-style tab strip at the window top edge');
  assert.ok(focusedShellBox.x >= 30 && focusedShellBox.x <= 38, `graph focus shell should begin after the Obsidian window frame inset, got x ${focusedShellBox.x}`);
  assert.ok(Math.abs(focusedGraphBox.x - (focusedShellBox.x + focusedShellBox.width)) <= 2, `graph focus should place the canvas after the Obsidian shell, got canvas ${focusedGraphBox.x}, shell ${focusedShellBox.x + focusedShellBox.width}`);
  assert.ok(Math.abs(focusedGraphBox.y - (focusedTitlebarBox.y + focusedTitlebarBox.height)) <= 2, `graph focus should place the canvas below the Obsidian tab strip, got canvas y ${focusedGraphBox.y}, titlebar bottom ${focusedTitlebarBox.y + focusedTitlebarBox.height}`);
  const focusedControlsDisplay = await page.evaluate(() => getComputedStyle(document.querySelector('.wiki-graph-controls')).display);
  assert.equal(focusedControlsDisplay, 'none', 'graph focus should hide the app zoom toolbar like Obsidian graph view');
  const focusedCanvasBackground = await page.evaluate(() => getComputedStyle(document.querySelector('.wiki-graph-canvas')).backgroundColor);
  assert.equal(focusedCanvasBackground, 'rgb(255, 255, 255)', 'graph focus should use Obsidian white canvas background');
  const focusedActiveLabelFontSize = await page.evaluate(() => {
    const activeNode = document.querySelector('.wiki-svg-node[data-active="true"] text');
    return Number.parseFloat(activeNode ? getComputedStyle(activeNode).fontSize : '0');
  });
  assert.ok(focusedActiveLabelFontSize >= 20, `graph focus should enlarge active node labels like Obsidian, got ${focusedActiveLabelFontSize}`);
  await page.getByRole('button', { name: '문서 트리 같이 보기' }).click();
  await page.waitForFunction(() => document.querySelector('.wiki-main')?.getAttribute('data-graph-focus') === 'false');
  await page.getByRole('button', { name: '타임랩스 애니메이션 시작' }).click();
  assert.equal(await page.locator('.wiki-graph-canvas').getAttribute('data-timelapse'), 'true');
  await page.waitForSelector('.wiki-graph-timelapse');
  const animationNames = await page.evaluate(() => ({
    edge: getComputedStyle(document.querySelector('.wiki-edge')).animationName,
    node: getComputedStyle(document.querySelector('.wiki-svg-node circle')).animationName,
  }));
  assert.match(animationNames.edge, /wikiGraphTrace/);
  assert.match(animationNames.node, /wikiGraphPulse/);
  await page.locator('.wiki-graph-canvas').focus();
  await page.keyboard.press('Control+=');
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform')?.includes('scale(1.42'));
  await page.keyboard.press('Control+0');
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform') === 'translate(0 0) scale(1)');
  const beforeWheelAnchor = await graphNodeScreenCenter(page, 'Linked alpha');
  assert.notEqual(beforeWheelAnchor, null, 'anchor node should have a screen center before wheel zoom');
  await page.mouse.move(beforeWheelAnchor.x, beforeWheelAnchor.y);
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform')?.includes('scale(1.16'));
  const afterWheelAnchor = await graphNodeScreenCenter(page, 'Linked alpha');
  assert.notEqual(afterWheelAnchor, null, 'anchor node should have a screen center after wheel zoom');
  assert.ok(
    Math.hypot(afterWheelAnchor.x - beforeWheelAnchor.x, afterWheelAnchor.y - beforeWheelAnchor.y) < 4,
    'wheel zoom should keep the node under the pointer like Obsidian',
  );
  await page.keyboard.press('Control+0');
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform') === 'translate(0 0) scale(1)');

  const hub = await graphNode(page, 'Hub strategy');
  await hub.hover();

  const hoverState = await page.evaluate(() => {
    const byTitle = (title) => [...document.querySelectorAll('.wiki-svg-node')]
      .find((node) => node.querySelector('title')?.textContent === title);
    return {
      hubFocus: byTitle('Hub strategy')?.getAttribute('data-focus'),
      linkedFocus: byTitle('Linked alpha')?.getAttribute('data-focus'),
      isolateMuted: byTitle('Daily isolate')?.getAttribute('data-muted'),
      focusedEdges: [...document.querySelectorAll('.wiki-edge')].filter((edge) => edge.getAttribute('data-focus') === 'true').length,
      mutedEdges: [...document.querySelectorAll('.wiki-edge')].filter((edge) => edge.getAttribute('data-muted') === 'true').length,
    };
  });

  assert.equal(hoverState.hubFocus, 'true');
  assert.equal(hoverState.linkedFocus, 'true');
  assert.equal(hoverState.isolateMuted, 'true');
  assert.equal(hoverState.focusedEdges, 2);
  assert.equal(hoverState.mutedEdges, 0);

  await page.mouse.move(24, 24);
  await page.waitForFunction(() => !document.querySelector('.wiki-svg-node[data-focus="true"]'));

  const beforeNode = await circlePoint(page, 'Hub strategy');
  const beforeEdge = await edgePoint(page, 0);
  const box = await hub.boundingBox();
  assert.notEqual(box, null);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 86, box.y + box.height / 2 + 44);
  await page.mouse.up();

  const afterNode = await circlePoint(page, 'Hub strategy');
  const afterEdge = await edgePoint(page, 0);
  assert.ok(Math.hypot(afterNode.x - beforeNode.x, afterNode.y - beforeNode.y) > 35, 'dragged node should move in graph coordinates');
  assert.notDeepEqual(afterEdge, beforeEdge, 'connected edge should track dragged node');
  assert.equal(await page.locator('.wiki-reader').count(), 0, 'dragging a node should not open the reader');

  await hub.click();
  await page.waitForFunction(() => !document.querySelector('.wiki-reader'));
  const selectedLabel = await page.evaluate(() => [...document.querySelectorAll('.wiki-svg-node text')].map((node) => node.textContent || '').join(' '));
  assert.match(selectedLabel, /Hub strategy/);
  await hub.dblclick();
  await page.waitForSelector('.wiki-reader');
  assert.match(await page.locator('.wiki-reader').textContent() || '', /Hub strategy/);

  await browser.close();
  console.log(JSON.stringify({ ok: true, hoverState, beforeNode, afterNode }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
