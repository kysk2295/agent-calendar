const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { evaluateFocusGraphTone, isolatedNotes, linkedNotes, notes, routeWikiApis } = require('./wiki-graph-fixtures.cjs');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const largeLinkedNotes = [
  { id: '2_wiki/active-hub.md', path: '2_wiki/active-hub.md', title: 'Active graph title', folder: '2_wiki', content: 'Central graph hub.' },
  ...Array.from({ length: 360 }, (_, index) => ({
    id: `2_wiki/dense-linked-${index + 1}.md`,
    path: `2_wiki/dense-linked-${index + 1}.md`,
    title: `Dense linked note ${index + 1}`,
    folder: '2_wiki',
    content: `Dense linked body ${index + 1}.`,
  })),
];

const largeIsolatedNotes = Array.from({ length: 360 }, (_, index) => ({
  id: `4_journal/dense-isolate-${index + 1}.md`,
  path: `4_journal/dense-isolate-${index + 1}.md`,
  title: `Dense isolated note ${index + 1}`,
  folder: '4_journal',
  content: `Dense isolated body ${index + 1}.`,
}));
const largeReferenceContextNotes = [
  {
    id: '1_raw/customer-discovery-evidence.md',
    path: '1_raw/customer-discovery-evidence.md',
    title: 'Customer discovery evidence',
    folder: '1_raw',
    content: 'Reference-like raw source context.',
  },
  {
    id: '3_output/quarterly-strategy-synthesis.md',
    path: '3_output/quarterly-strategy-synthesis.md',
    title: 'Quarterly strategy synthesis',
    folder: '3_output',
    content: 'Reference-like researcher output context.',
  },
];

const largeNotes = [...largeLinkedNotes, ...largeIsolatedNotes, ...largeReferenceContextNotes];
const largeGraph = {
  groups: ['2_wiki', '4_journal'],
  nodes: largeNotes.map((note) => ({
    id: note.path,
    path: note.path,
    title: note.title,
    label: note.title,
    group: note.folder,
  })),
  edges: [
    ...largeLinkedNotes.slice(1).map((note, index) => ({
      id: `dense-edge-${index + 1}`,
      from: '2_wiki/active-hub.md',
      to: note.path,
    })),
    ...largeLinkedNotes.slice(1, 80).flatMap((note, index, linked) => (
      linked.slice(index + 1, index + 4).map((target, targetIndex) => ({
        id: `dense-cross-edge-${index + 1}-${targetIndex + 1}`,
        from: note.path,
        to: target.path,
      }))
    )),
    ...largeReferenceContextNotes.flatMap((context, contextIndex) => [
      {
        id: `context-active-edge-${contextIndex + 1}`,
        from: '2_wiki/active-hub.md',
        to: context.path,
      },
      ...largeLinkedNotes.slice(1 + contextIndex * 12, 13 + contextIndex * 12).map((note, noteIndex) => ({
        id: `context-support-edge-${contextIndex + 1}-${noteIndex + 1}`,
        from: context.path,
        to: note.path,
      })),
    ]),
  ],
};
const largeWiki = { notes: largeNotes, documents: largeNotes, graph: largeGraph, selectedNote: largeLinkedNotes[0] };

function standardDeviation(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function rgbChannels(value) {
  const channels = String(value).match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) || [];
  assert.equal(channels.length, 3, `expected rgb color, got ${value}`);
  return channels;
}

async function routeLargeWikiApis(page) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && path === '/api/state') {
      await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], chatMessages: [], wikiIndex: largeWiki } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: largeWiki, notes: largeNotes, documents: largeNotes, graph: largeGraph, selectedNote: largeLinkedNotes[0] } });
      return;
    }
    await route.fulfill({ json: { ok: true, data: {} } });
  });
}

async function main() {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.doesNotMatch(appSource, /youtube-6aa|document-analysis-benchmark-evidence-paper/i, 'graph focus selection must not depend on one reference vault filename');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await routeWikiApis(page);

  await page.goto(target);
  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-graph-controls');
  await page.waitForSelector('.wiki-svg-node');

  const layout = await page.$$eval('.wiki-svg-node', (groups) => groups.map((group) => {
    const circle = group.querySelector('circle');
    const title = group.querySelector('title');
    return {
      title: title?.textContent || '',
      x: Number(circle?.getAttribute('cx')),
      y: Number(circle?.getAttribute('cy')),
      r: Number(circle?.getAttribute('r')),
    };
  }));

  assert.equal(layout.length, notes.length);
  layout.forEach((node) => {
    assert.equal(Number.isFinite(node.x), true, `${node.title} has finite x`);
    assert.equal(Number.isFinite(node.y), true, `${node.title} has finite y`);
    assert.equal(Number.isFinite(node.r), true, `${node.title} has finite r`);
  });

  const center = { x: 480, y: 310 };
  const radiusOf = (node) => Math.hypot(node.x - center.x, node.y - center.y);
  const linked = layout.filter((node) => node.title === 'Hub strategy' || node.title.startsWith('Linked note'));
  const isolated = layout.filter((node) => node.title.startsWith('Daily isolate'));
  const linkedRadii = linked.map(radiusOf);
  const isolatedRadii = isolated.map(radiusOf);
  const linkedAverage = linkedRadii.reduce((sum, value) => sum + value, 0) / linkedRadii.length;
  const isolatedAverage = isolatedRadii.reduce((sum, value) => sum + value, 0) / isolatedRadii.length;
  const isolatedRadiusDeviation = standardDeviation(isolatedRadii);
  const isolatedXDeviation = standardDeviation(isolated.map((node) => node.x));
  const isolatedYDeviation = standardDeviation(isolated.map((node) => node.y));
  const isolatedLeftShare = isolated.filter((node) => node.x < center.x - 150).length / isolated.length;
  const isolatedRightShare = isolated.filter((node) => node.x > center.x + 150).length / isolated.length;
  const isolatedTopShare = isolated.filter((node) => node.y < center.y - 120).length / isolated.length;
  const isolatedBottomShare = isolated.filter((node) => node.y > center.y + 120).length / isolated.length;
  const hub = layout.find((node) => node.title === 'Hub strategy');
  const leafAverageRadius = linked.filter((node) => node.title.startsWith('Linked note')).reduce((sum, node) => sum + node.r, 0) / (linked.length - 1);
  const activeNodeStyle = await page.evaluate(() => {
    const node = [...document.querySelectorAll('.wiki-svg-node')]
      .find((entry) => entry.querySelector('title')?.textContent === 'Hub strategy');
    const circle = node?.querySelector('circle');
    const style = circle ? getComputedStyle(circle) : null;
    return {
      fill: style?.fill || '',
      stroke: style?.stroke || '',
    };
  });
  const activeFill = rgbChannels(activeNodeStyle.fill);
  const activeStroke = rgbChannels(activeNodeStyle.stroke);

  assert.equal(linked.length, linkedNotes.length);
  assert.equal(isolated.length, isolatedNotes.length);
  assert.ok(hub.r > leafAverageRadius + 1.5, 'hub node grows from link count');
  assert.ok(Math.max(...activeFill) - Math.min(...activeFill) < 28, `active node fill should stay Obsidian-neutral, got ${activeNodeStyle.fill}`);
  assert.ok(Math.max(...activeStroke) - Math.min(...activeStroke) < 46, `active node stroke should stay Obsidian-neutral, got ${activeNodeStyle.stroke}`);
  assert.ok(linkedAverage < 180, `linked cluster should stay near center, got ${linkedAverage}`);
  assert.ok(isolatedAverage > linkedAverage + 120, `isolates should sit outside linked cluster, got ${isolatedAverage} vs ${linkedAverage}`);
  assert.ok(isolatedRadiusDeviation > 55, `isolates should scatter like Obsidian physics, not form a ring; got radius deviation ${isolatedRadiusDeviation}`);
  assert.ok(isolatedXDeviation > 190, `isolates should use broad horizontal space, got ${isolatedXDeviation}`);
  assert.ok(isolatedYDeviation > 140, `isolates should use broad vertical space, got ${isolatedYDeviation}`);
  assert.ok(isolatedLeftShare > 0.16 && isolatedRightShare > 0.16, `isolates should appear on both left and right, got ${isolatedLeftShare}/${isolatedRightShare}`);
  assert.ok(isolatedTopShare > 0.12 && isolatedBottomShare > 0.12, `isolates should appear above and below, got ${isolatedTopShare}/${isolatedBottomShare}`);

  await page.getByRole('button', { name: '그래프 집중 보기' }).click();
  await page.waitForSelector('.wiki-obsidian-titlebar');
  const focusWindowFrame = await page.evaluate(() => {
    const root = document.querySelector('.app-root');
    const content = document.querySelector('.content');
    const wiki = document.querySelector('.wiki[data-graph-focus="true"]');
    const wikiBox = wiki?.getBoundingClientRect();
    const contentBox = content?.getBoundingClientRect();
    const style = wiki ? getComputedStyle(wiki) : null;
    return {
      rootBackground: root ? getComputedStyle(root).backgroundColor : '',
      contentBackground: content ? getComputedStyle(content).backgroundColor : '',
      left: wikiBox?.left ?? 0,
      top: wikiBox?.top ?? 0,
      rightInset: contentBox && wikiBox ? contentBox.right - wikiBox.right : 0,
      bottomInset: contentBox && wikiBox ? contentBox.bottom - wikiBox.bottom : 0,
      radius: style?.borderRadius || '',
      shadow: style?.boxShadow || '',
      overflow: style?.overflow || '',
    };
  });
  assert.equal(focusWindowFrame.rootBackground, 'rgba(0, 0, 0, 0)', 'focus mode should keep the macOS window-capture backdrop transparent around the Obsidian window');
  assert.equal(focusWindowFrame.contentBackground, 'rgba(0, 0, 0, 0)', 'focus mode content area should match the transparent Obsidian window capture backdrop');
  assert.ok(focusWindowFrame.left >= 30 && focusWindowFrame.left <= 38, `focused Obsidian window should be inset from the left like the reference, got ${focusWindowFrame.left}`);
  assert.ok(focusWindowFrame.top >= 24 && focusWindowFrame.top <= 30, `focused Obsidian window should be inset from the top like the reference, got ${focusWindowFrame.top}`);
  assert.ok(focusWindowFrame.rightInset >= 30 && focusWindowFrame.rightInset <= 38, `focused Obsidian window should leave the right black capture margin, got ${focusWindowFrame.rightInset}`);
  assert.ok(focusWindowFrame.bottomInset >= 36 && focusWindowFrame.bottomInset <= 46, `focused Obsidian window should leave the bottom black capture margin, got ${focusWindowFrame.bottomInset}`);
  assert.ok(focusWindowFrame.radius.startsWith('12px') || focusWindowFrame.radius.startsWith('13px'), `focused Obsidian window should have macOS rounded corners, got ${focusWindowFrame.radius}`);
  assert.notEqual(focusWindowFrame.shadow, 'none', 'focused Obsidian window should preserve the subtle macOS window shadow in transparent captures');
  assert.equal(focusWindowFrame.overflow, 'hidden', 'focused Obsidian window should clip its rounded corners');
  const focusPalette = await page.evaluate(() => {
    const colorOf = (selector, property = 'backgroundColor') => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element)[property] : '';
    };
    return {
      window: colorOf('.wiki[data-graph-focus="true"]'),
      titlebar: colorOf('.wiki-obsidian-titlebar'),
      shell: colorOf('.wiki-obsidian-shell'),
      tree: colorOf('.wiki-obsidian-tree'),
      canvas: colorOf('.wiki-graph-canvas'),
      label: colorOf('.wiki-svg-node text', 'fill'),
      node: colorOf('.wiki-svg-node circle', 'fill'),
    };
  });
  ['window', 'titlebar', 'shell', 'tree', 'canvas'].forEach((surface) => {
    const [red, green, blue] = rgbChannels(focusPalette[surface]);
    assert.ok(Math.max(red, green, blue) <= 48, `${surface} should use Obsidian's dark surface, got ${focusPalette[surface]}`);
  });
  ['label'].forEach((foreground) => {
    const [red, green, blue] = rgbChannels(focusPalette[foreground]);
    assert.ok(Math.min(red, green, blue) >= 145, `${foreground} should remain visible on the dark graph, got ${focusPalette[foreground]}`);
  });
  const nodeChannels = rgbChannels(focusPalette.node);
  assert.ok(Math.min(...nodeChannels) >= 85, `node should remain visible as Obsidian's muted gray on the dark graph, got ${focusPalette.node}`);
  const focusTitlebar = await page.evaluate(() => {
    const titlebar = document.querySelector('.wiki-obsidian-titlebar');
    const tab = titlebar?.querySelector('.wiki-obsidian-tab[data-active="true"]');
    const shell = document.querySelector('.wiki-obsidian-shell');
    const box = titlebar?.getBoundingClientRect();
    const tabBox = tab?.getBoundingClientRect();
    const shellBox = shell?.getBoundingClientRect();
    return {
      display: titlebar ? getComputedStyle(titlebar).display : '',
      top: box?.top ?? 999,
      height: box?.height ?? 0,
      activeTabLeft: tabBox?.left ?? 0,
      shellRight: shellBox?.right ?? 999,
      tabText: tab?.textContent?.replace(/\s+/g, ' ').trim() || '',
      closeText: tab?.querySelector('i')?.textContent || '',
      newTabText: titlebar?.querySelector('.wiki-obsidian-new-tab')?.textContent || '',
      hasWindowControls: titlebar?.querySelectorAll('.wiki-obsidian-window-dot').length || 0,
      windowDotColors: [...(titlebar?.querySelectorAll('.wiki-obsidian-window-dot') || [])].map((entry) => getComputedStyle(entry).backgroundColor),
      workspaceIconCount: titlebar?.querySelectorAll('.wiki-obsidian-titlebar-workspace svg').length || 0,
      titleActionIconCount: titlebar?.querySelectorAll('.wiki-obsidian-title-actions svg').length || 0,
      titleActionText: titlebar?.querySelector('.wiki-obsidian-title-actions')?.textContent?.trim() || '',
    };
  });
  assert.equal(focusTitlebar.display, 'flex', 'focus mode should render Obsidian-style app title/tab strip');
  assert.ok(focusTitlebar.top >= 24 && focusTitlebar.top <= 30, `titlebar should sit at the top of the focused Obsidian window frame, got ${focusTitlebar.top}`);
  assert.ok(focusTitlebar.height >= 44 && focusTitlebar.height <= 52, `titlebar should match Obsidian tab strip height, got ${focusTitlebar.height}`);
  assert.ok(focusTitlebar.activeTabLeft >= focusTitlebar.shellRight - 1, `active graph tab should start over the graph pane, got tab ${focusTitlebar.activeTabLeft} shell ${focusTitlebar.shellRight}`);
  assert.ok(focusTitlebar.tabText.includes('그래프 뷰'), `active Obsidian tab should be graph view, got ${focusTitlebar.tabText}`);
  assert.equal(focusTitlebar.closeText, '×', 'active Obsidian tab should expose a close affordance');
  assert.equal(focusTitlebar.newTabText, '+', 'Obsidian tab strip should expose the new tab affordance');
  assert.equal(focusTitlebar.hasWindowControls, 3, 'Obsidian titlebar should include macOS window dots');
  assert.ok(new Set(focusTitlebar.windowDotColors).size <= 1, `focused Obsidian capture should show inactive gray window dots, got ${focusTitlebar.windowDotColors.join(', ')}`);
  assert.ok(focusTitlebar.workspaceIconCount >= 4, `Obsidian titlebar should keep workspace icons over the vault shell, got ${focusTitlebar.workspaceIconCount}`);
  assert.equal(focusTitlebar.titleActionIconCount, 2, 'Obsidian titlebar right side should expose dropdown and side-pane SVG controls');
  assert.equal(focusTitlebar.titleActionText, '', `Obsidian titlebar right side should not show app-specific command glyphs, got ${focusTitlebar.titleActionText}`);
  await page.waitForSelector('.wiki-graph-pane-chrome');
  const focusPaneChrome = await page.evaluate(() => {
    const chrome = document.querySelector('.wiki-graph-pane-chrome');
    const titlebar = document.querySelector('.wiki-obsidian-titlebar');
    const box = chrome?.getBoundingClientRect();
    const titlebarBox = titlebar?.getBoundingClientRect();
    return {
      title: chrome?.querySelector('strong')?.textContent || '',
      display: chrome ? getComputedStyle(chrome).display : '',
      top: box?.top ?? 999,
      belowTitlebar: (box?.top ?? 0) >= (titlebarBox?.bottom ?? 999),
    };
  });
  assert.equal(focusPaneChrome.title, '그래프 뷰', 'focus pane chrome should use the Obsidian graph title');
  assert.equal(focusPaneChrome.display, 'flex', 'focus pane chrome should render visibly');
  assert.equal(focusPaneChrome.belowTitlebar, true, 'focus pane chrome should sit below the Obsidian tab strip');
  const focusShell = await page.evaluate(() => {
    const shell = document.querySelector('.wiki-obsidian-shell');
    const rail = shell?.querySelector('.wiki-obsidian-rail');
    const tree = shell?.querySelector('.wiki-obsidian-tree');
    const canvas = document.querySelector('.wiki-graph-canvas');
    const shellBox = shell?.getBoundingClientRect();
    const railBox = rail?.getBoundingClientRect();
    const treeBox = tree?.getBoundingClientRect();
    const canvasBox = canvas?.getBoundingClientRect();
    const toolbarButtons = [...(tree?.querySelectorAll('.wiki-obsidian-tree-toolbar > span') || [])];
    const toolbarBoxes = toolbarButtons.map((entry) => entry.getBoundingClientRect());
    const toolbarIcons = toolbarButtons.map((entry) => entry.querySelector('svg')?.innerHTML.trim() || '');
    return {
      display: shell ? getComputedStyle(shell).display : '',
      shellWidth: shellBox?.width ?? 0,
      railWidth: railBox?.width ?? 0,
      treeWidth: treeBox?.width ?? 0,
      canvasLeft: canvasBox?.left ?? 0,
      shellRight: shellBox?.right ?? 0,
      toolbarLabels: toolbarButtons.map((entry) => entry.getAttribute('aria-label') || ''),
      toolbarControls: toolbarButtons.map((entry) => entry.getAttribute('data-obsidian-toolbar-control') || ''),
      toolbarTags: toolbarButtons.map((entry) => entry.tagName.toLowerCase()),
      toolbarSvgCount: toolbarButtons.filter((entry) => entry.querySelector('svg')).length,
      toolbarUniqueIconCount: new Set(toolbarIcons).size,
      toolbarWidths: toolbarBoxes.map((box) => box.width),
      toolbarHeights: toolbarBoxes.map((box) => box.height),
      toolbarFirstOffset: toolbarBoxes[0] && treeBox ? toolbarBoxes[0].left - treeBox.left : 0,
      toolbarLastOffset: toolbarBoxes.at(-1) && treeBox ? toolbarBoxes.at(-1).right - treeBox.left : 0,
      vaultName: shell?.querySelector('.wiki-obsidian-vault')?.textContent || '',
      vaultControlLabels: [...(shell?.querySelectorAll('.wiki-obsidian-vault-control') || [])].map((entry) => entry.getAttribute('aria-label') || ''),
      vaultSwitcherText: shell?.querySelector('.wiki-obsidian-vault-control[aria-label="vault switcher"]')?.textContent?.trim() || '',
      vaultSwitcherSvgCount: shell?.querySelectorAll('.wiki-obsidian-vault-control[aria-label="vault switcher"] svg').length || 0,
      treeFirst: tree?.querySelector('button span')?.textContent || '',
      folderLabels: [...(tree?.querySelectorAll('.wiki-obsidian-folder-row > span') || [])].map((entry) => entry.textContent || ''),
      childLabels: [...(tree?.querySelectorAll('.wiki-obsidian-folder-child') || [])].map((entry) => entry.textContent?.trim() || ''),
      activeRailBackground: rail?.querySelector('span[data-active="true"]') ? getComputedStyle(rail.querySelector('span[data-active="true"]')).backgroundColor : '',
    };
  });
  assert.equal(focusShell.display, 'grid', 'focus mode should render an Obsidian-like vault shell beside the graph pane');
  assert.ok(focusShell.shellWidth >= 405 && focusShell.shellWidth <= 425, `focus shell should match Obsidian vault shell width, got ${focusShell.shellWidth}`);
  assert.ok(focusShell.railWidth >= 48 && focusShell.railWidth <= 58, `focus shell rail should match Obsidian icon rail width, got ${focusShell.railWidth}`);
  assert.equal(focusShell.activeRailBackground, 'rgba(0, 0, 0, 0)', `focus shell graph rail icon should not have an active fill in the reference crop, got ${focusShell.activeRailBackground}`);
  assert.ok(focusShell.treeWidth >= 350 && focusShell.treeWidth <= 370, `focus shell tree should match Obsidian file explorer width, got ${focusShell.treeWidth}`);
  assert.ok(focusShell.canvasLeft >= focusShell.shellRight - 1, `graph pane should begin after the Obsidian shell, got canvas ${focusShell.canvasLeft} shell ${focusShell.shellRight}`);
  assert.deepEqual(focusShell.toolbarLabels, ['새 노트', '새 폴더', '정렬', '접기', '닫기'], 'focus shell tree toolbar should match Obsidian file explorer controls');
  assert.deepEqual(focusShell.toolbarControls, ['new-note', 'new-folder', 'sort', 'collapse', 'close'], 'focus shell tree toolbar should expose Obsidian file explorer control roles');
  assert.deepEqual(focusShell.toolbarTags, ['span', 'span', 'span', 'span', 'span'], 'decorative focus shell toolbar icons should not be exposed as interactive buttons');
  assert.equal(focusShell.toolbarSvgCount, 5, 'focus shell tree toolbar should render SVG icons instead of placeholder boxes');
  assert.equal(focusShell.toolbarUniqueIconCount, 5, 'focus shell tree toolbar icons should have distinct Obsidian-like shapes');
  focusShell.toolbarWidths.forEach((width) => assert.ok(width >= 22 && width <= 24, `tree toolbar control width should be close to Obsidian icon button size, got ${width}`));
  focusShell.toolbarHeights.forEach((height) => assert.ok(height >= 22 && height <= 24, `tree toolbar control height should be close to Obsidian icon button size, got ${height}`));
  assert.ok(focusShell.toolbarFirstOffset >= 92 && focusShell.toolbarFirstOffset <= 112, `tree toolbar should start near the Obsidian reference icon row, got ${focusShell.toolbarFirstOffset}`);
  assert.ok(focusShell.toolbarLastOffset >= 248 && focusShell.toolbarLastOffset <= 274, `tree toolbar should end near the Obsidian reference icon row, got ${focusShell.toolbarLastOffset}`);
  assert.ok(focusShell.vaultName.includes('LLM-Wiki'), 'focus shell should expose the Obsidian vault name');
  ['vault switcher', 'help', 'settings'].forEach((label) => {
    assert.ok(focusShell.vaultControlLabels.includes(label), `focus shell footer should expose Obsidian ${label} control`);
  });
  assert.equal(focusShell.vaultSwitcherSvgCount, 1, 'focus shell vault switcher should render the Obsidian stacked chevron SVG');
  assert.equal(focusShell.vaultSwitcherText, '', `focus shell vault switcher should not collapse into a text glyph, got ${focusShell.vaultSwitcherText}`);
  assert.equal(focusShell.treeFirst, '0_inbox', `focus shell should list Obsidian vault folders from the root, got ${focusShell.treeFirst}`);
  ['0_inbox', '1_raw', '2_wiki', '3_output', '4_journal'].forEach((folder) => {
    assert.ok(focusShell.folderLabels.includes(folder), `focus shell should include Obsidian vault folder ${folder}`);
  });
  assert.equal(focusShell.childLabels[0], '_me', `expanded journal folder should show the Obsidian _me child first, got ${focusShell.childLabels[0]}`);
  assert.equal(focusShell.childLabels[1], '2025-03-21', `expanded journal folder should begin from the Obsidian reference date sequence, got ${focusShell.childLabels[1]}`);
  assert.ok(focusShell.childLabels.includes('2025-03-21'), `expanded journal folder should show date children like Obsidian, got ${focusShell.childLabels.slice(0, 5).join(', ')}`);
  assert.ok(focusShell.childLabels.length >= 25, `expanded journal folder should continue through the Obsidian reference lower date area, got ${focusShell.childLabels.length} children`);
  assert.equal(focusShell.folderLabels.includes('5_conversation'), false, 'focus shell should not show extra root folders before the reference journal date sequence ends');
  await page.mouse.move(240, 240);
  await page.locator('.wiki-graph-canvas').focus();
  const defaultFocusLabelSizes = await page.$$eval('.wiki-svg-node text', (labels) => labels.map((label) => Number.parseFloat(getComputedStyle(label).fontSize || '0')));
  assert.ok(Math.max(...defaultFocusLabelSizes) <= 11, `default focus graph labels should stay small like Obsidian's global graph, got ${Math.max(...defaultFocusLabelSizes)}px`);
  const focusSideActionsStyle = await page.evaluate(() => {
    const sideActions = document.querySelector('.wiki-graph-side-actions');
    const focusExit = document.querySelector('.wiki-graph-side-actions button');
    const sideStyle = sideActions ? getComputedStyle(sideActions) : null;
    const exitStyle = focusExit ? getComputedStyle(focusExit) : null;
    const canvasBox = document.querySelector('.wiki-graph-canvas')?.getBoundingClientRect();
    const paneChromeBox = document.querySelector('.wiki-graph-pane-chrome')?.getBoundingClientRect();
    const actionsBox = sideActions?.getBoundingClientRect();
    const buttons = [...(sideActions?.querySelectorAll('button') || [])];
    const buttonBoxes = buttons.map((button) => button.getBoundingClientRect());
    return {
      opacity: Number.parseFloat(sideStyle?.opacity || ''),
      exitBackground: exitStyle?.backgroundColor || '',
      topFromCanvas: actionsBox && canvasBox ? actionsBox.top - canvasBox.top : 0,
      topAfterPaneChrome: actionsBox && paneChromeBox ? actionsBox.top - paneChromeBox.bottom : 0,
      rightInset: actionsBox && canvasBox ? canvasBox.right - actionsBox.right : 0,
      controls: buttons.map((button) => button.getAttribute('data-obsidian-control') || ''),
      labels: buttons.map((button) => button.getAttribute('aria-label') || ''),
      widths: buttonBoxes.map((box) => box.width),
      heights: buttonBoxes.map((box) => box.height),
      gaps: buttonBoxes.slice(1).map((box, index) => box.top - buttonBoxes[index].bottom),
    };
  });
  assert.ok(focusSideActionsStyle.opacity <= 0.58, `focus side actions should be quiet like Obsidian graph controls, got ${focusSideActionsStyle.opacity}`);
  assert.equal(focusSideActionsStyle.exitBackground, 'rgba(0, 0, 0, 0)', 'focus exit action should not look like a floating card at rest');
  assert.deepEqual(focusSideActionsStyle.controls, ['fullscreen', 'local-graph', 'settings', 'timelapse'], 'focus side actions should expose Obsidian graph control roles');
  assert.deepEqual(focusSideActionsStyle.labels, ['문서 트리 같이 보기', '로컬 그래프 보기', '그래프 설정 열기', '타임랩스 애니메이션 시작'], 'focus side actions should use graph-control labels');
  assert.ok(focusSideActionsStyle.topFromCanvas >= 58, `focus side actions should sit below the pane chrome, got ${focusSideActionsStyle.topFromCanvas}`);
  assert.ok(focusSideActionsStyle.topAfterPaneChrome >= 18, `focus side actions should leave room below the Obsidian pane chrome, got ${focusSideActionsStyle.topAfterPaneChrome}`);
  assert.ok(focusSideActionsStyle.rightInset >= 14 && focusSideActionsStyle.rightInset <= 22, `focus side actions should hug the graph pane right edge, got ${focusSideActionsStyle.rightInset}`);
  focusSideActionsStyle.widths.forEach((width) => assert.ok(width >= 23 && width <= 25, `Obsidian graph control width should be 24px, got ${width}`));
  focusSideActionsStyle.heights.forEach((height) => assert.ok(height >= 23 && height <= 25, `Obsidian graph control height should be 24px, got ${height}`));
  focusSideActionsStyle.gaps.forEach((gap) => assert.ok(gap >= 13 && gap <= 17, `Obsidian graph controls should keep compact vertical rhythm, got ${gap}`));
  const beforeFocusZoomLabelCount = await page.locator('.wiki-svg-node text').count();
  await page.locator('.wiki-graph-canvas').focus();
  await page.keyboard.press('Control+=');
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform')?.includes('scale(1.42)'));
  const afterFocusZoomLabelCount = await page.locator('.wiki-svg-node text').count();
  assert.ok(afterFocusZoomLabelCount > beforeFocusZoomLabelCount + 8, `focus zoom should reveal surrounding labels like Obsidian, got ${beforeFocusZoomLabelCount} -> ${afterFocusZoomLabelCount}`);
  const isolatedFocusZoomLabelCount = await page.$$eval('.wiki-svg-node text', (labels) => labels.filter((label) => (label.textContent || '').startsWith('Daily isolate')).length);
  assert.ok(isolatedFocusZoomLabelCount < 8, `focus zoom should avoid flooding the pane with isolated-note labels, got ${isolatedFocusZoomLabelCount}`);
  const focusZoomLabelOverlap = await page.$$eval('.wiki-svg-node text', (labels) => {
    const boxes = labels
      .filter((label) => /^(Hub strategy|Linked note)/.test(label.textContent || ''))
      .map((label) => {
        const box = label.getBoundingClientRect();
        return {
          text: label.textContent || '',
          width: box.width,
          height: box.height,
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
        };
      });
    const pairs = [];
    for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
        const left = boxes[leftIndex];
        const right = boxes[rightIndex];
        const overlapWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
        const overlapHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
        const area = overlapWidth * overlapHeight;
        if (area <= 0) continue;
        const smallerArea = Math.max(1, Math.min(left.width * left.height, right.width * right.height));
        pairs.push({
          labels: `${left.text} / ${right.text}`,
          ratio: area / smallerArea,
        });
      }
    }
    return {
      count: boxes.length,
      pairs: pairs.length,
      maxRatio: Math.max(0, ...pairs.map((pair) => pair.ratio)),
      worstPair: pairs.sort((left, right) => right.ratio - left.ratio)[0]?.labels || '',
    };
  });
  assert.ok(focusZoomLabelOverlap.count >= 9, `focus zoom should keep enough labels visible for comparison, got ${focusZoomLabelOverlap.count}`);
  assert.ok(focusZoomLabelOverlap.pairs <= 4, `focus zoom labels should avoid Obsidian-unlike overlap pileups, got ${focusZoomLabelOverlap.pairs} overlapping pairs`);
  assert.ok(focusZoomLabelOverlap.maxRatio <= 0.25, `focus zoom labels should not substantially overlap; worst ${focusZoomLabelOverlap.worstPair} at ${focusZoomLabelOverlap.maxRatio}`);
  const focusGraphTone = await evaluateFocusGraphTone(page);
  assert.ok(focusGraphTone.linkedLabelCount >= 8, `focus zoom should expose linked-note labels for visual comparison, got ${focusGraphTone.linkedLabelCount}`);
  assert.ok(focusGraphTone.minLinkedLabelFontSize >= 18, `focus zoom linked labels should read large like Obsidian graph labels, got ${focusGraphTone.minLinkedLabelFontSize}`);
  assert.ok(focusGraphTone.maxHotEdgeOpacity <= 0.48, `focus graph hot edges should stay pale like Obsidian, got opacity ${focusGraphTone.maxHotEdgeOpacity}`);
  assert.ok(focusGraphTone.maxHotEdgeWidth <= 1, `focus graph hot edges should stay hairline-thin like Obsidian, got width ${focusGraphTone.maxHotEdgeWidth}`);

  const largePage = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  await routeLargeWikiApis(largePage);
  await largePage.goto(target);
  await largePage.getByRole('button', { name: /위키/ }).click();
  await largePage.waitForSelector('.wiki-svg-node');
  await largePage.getByRole('button', { name: '그래프 집중 보기' }).click();
  await largePage.waitForSelector('.wiki-obsidian-titlebar');
  const largeBoundaryPinnedNodes = await largePage.$$eval('.wiki-svg-node:not([data-isolated="true"]) circle', (circles) => circles.filter((circle) => {
    const x = Number(circle.getAttribute('cx'));
    const y = Number(circle.getAttribute('cy'));
    return Math.abs(x - 58) < .01 || Math.abs(x - 902) < .01 || Math.abs(y - 58) < .01 || Math.abs(y - 562) < .01;
  }).length);
  assert.ok(largeBoundaryPinnedNodes <= 1, `large global graph should not pin linked hubs to a rectangular boundary, got ${largeBoundaryPinnedNodes}`);
  await largePage.locator('.wiki-graph-canvas').focus();
  await largePage.keyboard.press('Control+=');
  await largePage.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform')?.includes('scale(1.42)'));
  const largeFocusZoomLabelStats = await largePage.$$eval('.wiki-svg-node text', (labels) => {
    const visibleLabels = labels.map((label) => label.textContent || '');
    const canvas = document.querySelector('.wiki-graph-canvas')?.getBoundingClientRect();
    const labelRatio = (prefix) => {
      const label = labels.find((entry) => (entry.textContent || '').startsWith(prefix));
      const box = label?.getBoundingClientRect();
      return canvas && box
        ? {
          x: (box.x + box.width / 2 - canvas.x) / canvas.width,
          y: (box.y + box.height / 2 - canvas.y) / canvas.height,
          left: (box.x - canvas.x) / canvas.width,
        }
        : null;
    };
    const contextRatios = ['customer-discovery-evidence', 'quarterly-strategy-synthesis']
      .map(labelRatio)
      .filter(Boolean)
      .sort((left, right) => left.x - right.x);
    return {
      labels: visibleLabels,
      count: visibleLabels.length,
      activeBasenameLabels: visibleLabels.filter((label) => label === 'active-hub').length,
      activeTitleLabels: visibleLabels.filter((label) => label === 'Active graph title').length,
      linkedLabels: visibleLabels.filter((label) => label.startsWith('dense-linked-')).length,
      rawContextLabels: visibleLabels.filter((label) => label === 'customer-discovery-evidence').length,
      outputContextLabels: visibleLabels.filter((label) => label === 'quarterly-strategy-synthesis').length,
      outputContextText: visibleLabels.find((label) => label === 'quarterly-strategy-synthesis') || '',
      isolatedLabels: visibleLabels.filter((label) => label.startsWith('Dense isolated note')).length,
      contextRatios,
    };
  });
  const largeVisibleNodeCount = await largePage.evaluate(() => {
    const canvas = document.querySelector('.wiki-graph-canvas')?.getBoundingClientRect();
    if (!canvas) return 0;
    return [...document.querySelectorAll('.wiki-svg-node circle')].filter((circle) => {
      const box = circle.getBoundingClientRect();
      return box.right >= canvas.left && box.left <= canvas.right && box.bottom >= canvas.top && box.top <= canvas.bottom;
    }).length;
  });
  const largeFocusEdgeCount = await largePage.locator('.wiki-edge').count();
  const largeActivePlacement = await largePage.evaluate(() => {
    const canvas = document.querySelector('.wiki-graph-canvas')?.getBoundingClientRect();
    const activeCircleElement = document.querySelector('.wiki-svg-node[data-active="true"] circle');
    const activeCircle = activeCircleElement?.getBoundingClientRect();
    const activeCircleStyle = activeCircleElement ? getComputedStyle(activeCircleElement) : null;
    const activeLabelElement = document.querySelector('.wiki-svg-node[data-active="true"] text');
    const activeLabel = activeLabelElement?.getBoundingClientRect();
    const activeLabelStyle = activeLabelElement ? getComputedStyle(activeLabelElement) : null;
    const contextLabelElement = document.querySelector('.wiki-svg-node[data-context="true"] text');
    const contextLabelStyle = contextLabelElement ? getComputedStyle(contextLabelElement) : null;
    return {
      circleRatio: canvas && activeCircle
        ? {
          x: (activeCircle.x + activeCircle.width / 2 - canvas.x) / canvas.width,
          y: (activeCircle.y + activeCircle.height / 2 - canvas.y) / canvas.height,
        }
        : null,
      labelRatio: canvas && activeLabel
        ? {
          x: (activeLabel.x + activeLabel.width / 2 - canvas.x) / canvas.width,
          y: (activeLabel.y + activeLabel.height / 2 - canvas.y) / canvas.height,
        }
        : null,
      activeStrokeWidth: Number.parseFloat(activeLabelStyle?.strokeWidth || '0'),
      activeFontWeight: Number.parseFloat(activeLabelStyle?.fontWeight || '0'),
      contextStrokeWidth: Number.parseFloat(contextLabelStyle?.strokeWidth || '0'),
      contextFontWeight: Number.parseFloat(contextLabelStyle?.fontWeight || '0'),
      activeCircleOpacity: Number.parseFloat(activeCircleStyle?.opacity || '1'),
    };
  });
  assert.equal(largeFocusZoomLabelStats.activeBasenameLabels, 1, 'large focus graph should show the active node filename like Obsidian');
  assert.equal(largeFocusZoomLabelStats.activeTitleLabels, 0, 'large focus graph should not show frontmatter/title labels in Obsidian crop mode');
  assert.equal(largeFocusZoomLabelStats.linkedLabels, 0, `large focus graph should not leak arbitrary linked labels into the Obsidian reference crop, got ${largeFocusZoomLabelStats.labels.join(', ')}`);
  assert.ok(largeFocusZoomLabelStats.count <= 3, `large focus graph should keep only active and exact context labels in the Obsidian reference crop, got ${largeFocusZoomLabelStats.count}`);
  assert.equal(largeFocusZoomLabelStats.rawContextLabels, 1, 'large focus graph should select a data-driven raw context label');
  assert.equal(largeFocusZoomLabelStats.outputContextLabels, 1, 'large focus graph should select a data-driven output context label');
  assert.ok(
    largeFocusZoomLabelStats.outputContextText.length <= 38,
    `large focus graph should crop long context labels like Obsidian, got ${largeFocusZoomLabelStats.outputContextText.length} chars`,
  );
  assert.equal(largeFocusZoomLabelStats.contextRatios.length, 2, 'large focus graph should expose two data-driven context label placements');
  const [leftContextRatio, rightContextRatio] = largeFocusZoomLabelStats.contextRatios;
  assert.ok(
    leftContextRatio.x >= 0.005 && leftContextRatio.x <= 0.025,
    `large focus graph should crop one context label at the left edge like Obsidian, got x ${leftContextRatio.x}`,
  );
  assert.ok(
    leftContextRatio.y >= 0.56 && leftContextRatio.y <= 0.72,
    `large focus graph should place one context label near the lower-left crop, got y ${leftContextRatio.y}`,
  );
  assert.ok(
    rightContextRatio.left >= 0.58 && rightContextRatio.left <= 0.66,
    `large focus graph should start one context label near the lower-right crop, got left ${rightContextRatio.left}`,
  );
  assert.ok(
    rightContextRatio.x >= 0.70 && rightContextRatio.x <= 1.00,
    `large focus graph should place one context label near the lower-right crop, got x ${rightContextRatio.x}`,
  );
  assert.ok(
    rightContextRatio.y >= 0.52 && rightContextRatio.y <= 0.70,
    `large focus graph should place one context label near the lower-right crop, got y ${rightContextRatio.y}`,
  );
  assert.equal(largeFocusZoomLabelStats.isolatedLabels, 0, `large focus graph should not show isolated labels at zoom, got ${largeFocusZoomLabelStats.isolatedLabels}`);
  assert.ok(largeVisibleNodeCount <= 3, `large focus graph should zoom into the sparse active/context Obsidian crop, got ${largeVisibleNodeCount} visible nodes`);
  assert.ok(largeFocusEdgeCount >= 36 && largeFocusEdgeCount <= 46, `large focus graph should keep enough pale background edges for the Obsidian reference crop, got ${largeFocusEdgeCount}`);
  assert.ok(largeActivePlacement.circleRatio, 'large focus graph should expose the active circle placement');
  assert.ok(largeActivePlacement.labelRatio, 'large focus graph should expose the active label placement');
  assert.ok(
    largeActivePlacement.circleRatio.x >= 0.44 && largeActivePlacement.circleRatio.x <= 0.62,
    `large focus graph should pan the active node into the Obsidian reference upper graph area, got x ${largeActivePlacement.circleRatio.x}`,
  );
  assert.ok(
    largeActivePlacement.circleRatio.y >= 0.10 && largeActivePlacement.circleRatio.y <= 0.21,
    `large focus graph should pan the active node into the Obsidian reference upper graph area, got y ${largeActivePlacement.circleRatio.y}`,
  );
  assert.ok(
    largeActivePlacement.labelRatio.x >= 0.55 && largeActivePlacement.labelRatio.x <= 0.76,
    `large focus graph active label should land near the Obsidian reference top label position, got x ${largeActivePlacement.labelRatio.x}`,
  );
  assert.ok(
    largeActivePlacement.labelRatio.y >= 0.08 && largeActivePlacement.labelRatio.y <= 0.18,
    `large focus graph active label should land near the Obsidian reference top label position, got y ${largeActivePlacement.labelRatio.y}`,
  );
  assert.ok(
    largeActivePlacement.activeStrokeWidth <= 3,
    `large focus graph active label should use a lighter Obsidian-like halo, got stroke width ${largeActivePlacement.activeStrokeWidth}`,
  );
  assert.ok(
    largeActivePlacement.contextStrokeWidth <= 3,
    `large focus graph context labels should use a lighter Obsidian-like halo, got stroke width ${largeActivePlacement.contextStrokeWidth}`,
  );
  assert.ok(
    largeActivePlacement.activeFontWeight <= 560,
    `large focus graph active label should use Obsidian-like medium weight, got ${largeActivePlacement.activeFontWeight}`,
  );
  assert.ok(
    largeActivePlacement.contextFontWeight <= 560,
    `large focus graph context labels should use Obsidian-like medium weight, got ${largeActivePlacement.contextFontWeight}`,
  );
  assert.ok(
    largeActivePlacement.activeCircleOpacity <= 0.1,
    `large focus graph dense crop should hide the active dot like the Obsidian reference label crop, got opacity ${largeActivePlacement.activeCircleOpacity}`,
  );
  await largePage.close();

  const currentReferencePage = await browser.newPage({ viewport: { width: 1224, height: 768 } });
  await routeWikiApis(currentReferencePage);
  await currentReferencePage.goto(target);
  await currentReferencePage.getByRole('button', { name: /위키/ }).click();
  await currentReferencePage.waitForSelector('.wiki-svg-node');
  await currentReferencePage.getByRole('button', { name: '그래프 집중 보기' }).click();
  const currentReferenceGeometry = await currentReferencePage.evaluate(() => {
    const wiki = document.querySelector('.wiki[data-graph-focus="true"]')?.getBoundingClientRect();
    const shell = document.querySelector('.wiki-obsidian-shell')?.getBoundingClientRect();
    const canvas = document.querySelector('.wiki-graph-canvas')?.getBoundingClientRect();
    return {
      wikiLeft: wiki?.left ?? -1,
      wikiTop: wiki?.top ?? -1,
      wikiWidth: wiki?.width ?? 0,
      wikiHeight: wiki?.height ?? 0,
      shellWidth: shell?.width ?? 0,
      canvasRatio: canvas ? canvas.width / canvas.height : 0,
    };
  });
  assert.equal(currentReferenceGeometry.wikiLeft, 0, 'current Obsidian app reference should fill the compact capture width');
  assert.equal(currentReferenceGeometry.wikiTop, 0, 'current Obsidian app reference should fill the compact capture height');
  assert.equal(currentReferenceGeometry.wikiWidth, 1224, 'current Obsidian app reference should use the full compact viewport width');
  assert.equal(currentReferenceGeometry.wikiHeight, 768, 'current Obsidian app reference should use the full compact viewport height');
  assert.ok(currentReferenceGeometry.shellWidth >= 325 && currentReferenceGeometry.shellWidth <= 340, `current Obsidian shell should match the compact reference width, got ${currentReferenceGeometry.shellWidth}`);
  assert.ok(currentReferenceGeometry.canvasRatio >= 1.18 && currentReferenceGeometry.canvasRatio <= 1.28, `current Obsidian graph pane should match the reference aspect ratio, got ${currentReferenceGeometry.canvasRatio}`);
  await currentReferencePage.close();

  await browser.close();
  console.log(JSON.stringify({ ok: true, linkedAverage, isolatedAverage, isolatedRadiusDeviation, isolatedXDeviation, isolatedYDeviation }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
