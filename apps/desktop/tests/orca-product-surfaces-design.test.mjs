import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const mainSource = await readFile(new URL('src/main.tsx', desktopRoot), 'utf8');
const appSource = await readFile(new URL('src/App.tsx', desktopRoot), 'utf8');
const cssSource = await readFile(new URL('src/styles.css', desktopRoot), 'utf8');
const onboardingSource = await readFile(new URL('src/features/onboarding/OnboardingGuide.tsx', desktopRoot), 'utf8');
const onboardingCss = await readFile(new URL('src/features/onboarding/onboarding.css', desktopRoot), 'utf8');
const controlRoomSource = await readFile(new URL('src/features/agent-operations/AgentControlRoomBoard.tsx', desktopRoot), 'utf8');
const controlRoomCss = await readFile(new URL('src/features/agent-operations/agent-workspace.css', desktopRoot), 'utf8');
const runnerSource = await readFile(new URL('src/features/runner/RunnerSetupPanel.tsx', desktopRoot), 'utf8');
const conversationSource = await readFile(new URL('src/features/agent-operations/AgentWorkConversationView.tsx', desktopRoot), 'utf8');
const wikiSource = await readFile(new URL('src/features/knowledge/WikiScreen.tsx', desktopRoot), 'utf8');
const wikiGraphSource = await readFile(new URL('src/features/knowledge/WikiGraphPanel.tsx', desktopRoot), 'utf8');

function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS block for ${selector}`);
  return match[1];
}

test('product chrome uses Orca-like neutral surfaces in light and dark modes', () => {
  const root = cssBlock(cssSource, ':root');
  assert.match(root, /--canvas:\s*#FFFFFF/i);
  assert.match(root, /--main:\s*#FFFFFF/i);
  assert.match(root, /--bar:\s*#FAFAFA/i);
  assert.match(root, /--sidebar:\s*#F5F5F5/i);
  assert.match(root, /--panel:\s*#FFFFFF/i);
  assert.match(root, /--line:\s*#E5E5E5/i);
  assert.match(root, /--text:\s*#171717/i);
  assert.match(root, /--muted:\s*#737373/i);
  assert.match(root, /--action:\s*#171717/i);
  assert.match(root, /--action-text:\s*#FAFAFA/i);
  assert.doesNotMatch(root, /#EAE5DA|#F4F0E8|#F7F3EB|#EFEADF|#FBF9F4/);

  const dark = cssBlock(cssSource, '.app-root[data-theme="dark"]');
  assert.match(dark, /--canvas:\s*#0A0A0A/i);
  assert.match(dark, /--main:\s*#0A0A0A/i);
  assert.match(dark, /--bar:\s*#171717/i);
  assert.match(dark, /--sidebar:\s*#171717/i);
  assert.match(dark, /--panel:\s*#171717/i);
  assert.match(dark, /--action:\s*#FAFAFA/i);
  assert.match(dark, /--action-text:\s*#171717/i);
  assert.doesNotMatch(dark, /#28241E|#312C25|#383128|#342E26|#40382E/);
});

test('sidebar keeps the three product pillars visible and moves secondary tools behind one disclosure', () => {
  const navStart = appSource.indexOf('const primaryNavItems');
  const navEnd = appSource.indexOf('function arr', navStart);
  assert.ok(navStart >= 0 && navEnd > navStart, 'Missing focused navigation definitions');
  const navigation = appSource.slice(navStart, navEnd);
  assert.match(navigation, /id:\s*'calendar'/);
  assert.match(navigation, /id:\s*'agents'/);
  assert.match(navigation, /id:\s*'automation'/);
  assert.match(navigation, /const secondaryNavItems/);

  const sidebarStart = appSource.indexOf('<aside className="sidebar">');
  const sidebarEnd = appSource.indexOf('</aside>', sidebarStart);
  const sidebar = appSource.slice(sidebarStart, sidebarEnd);
  assert.match(sidebar, /className="nav-primary"/);
  assert.match(sidebar, /className="nav-more"/);
  assert.match(sidebar, /<summary>[\s\S]*작업공간[\s\S]*<\/summary>/);
  assert.match(sidebar, /secondaryNavOpen/);
  const disclosureEnd = sidebar.indexOf('</details>');
  const taxonomyGroups = sidebar.indexOf('{navGroups.map');
  assert.ok(taxonomyGroups >= 0 && taxonomyGroups < disclosureEnd, 'Lists and tags must stay inside the workspace disclosure');

  const active = cssBlock(cssSource, '.nav-item[data-active="true"]');
  assert.doesNotMatch(active, /accent/);
  assert.doesNotMatch(cssSource, /\.nav-item\[data-active="true"\]::before/);
  const more = cssBlock(cssSource, '.nav-more');
  assert.match(more, /border-top:\s*1px solid var\(--line-soft\)/);
});

test('login is a focused workspace entry instead of a decorative AI splash', () => {
  const start = appSource.indexOf('function AgentCalendarLoginExperience');
  const end = appSource.indexOf('function TaskDetailModal', start);
  const login = appSource.slice(start, end);
  assert.match(login, /login-workspace-entry/);
  assert.match(login, /login-boundary-note/);
  assert.doesNotMatch(login, /login-splash|splash-orbit|orbit-node|login-trust-list/);
  assert.doesNotMatch(login, /일은 나눠서|하루는 한눈에/);
});

test('settings is a full-screen two-pane tool surface with one active pane', () => {
  const start = appSource.indexOf('function SettingsOverlay');
  const end = appSource.indexOf('function RunReport', start);
  const settings = appSource.slice(start, end);
  assert.match(settings, /type SettingsPaneId/);
  assert.match(settings, /activeSettingsPane/);
  assert.match(settings, /settings-sidebar/);
  assert.match(settings, /settings-main/);
  assert.match(settings, /settings-nav-button/);
  assert.match(settings, /settings-section/);
  assert.match(settings, /settings-theme-list/);
  assert.doesNotMatch(settings, /href="#settings-|theme-grid|theme-preview|v0\.9|로컬 저장/);

  const backdropBlocks = [...cssSource.matchAll(/(?:^|\n)\.settings-backdrop\s*\{([^}]+)\}/g)];
  const overlayBlocks = [...cssSource.matchAll(/(?:^|\n)\.settings-overlay\s*\{([^}]+)\}/g)];
  const backdrop = backdropBlocks.at(-1)?.[1] || '';
  const overlay = overlayBlocks.at(-1)?.[1] || '';
  assert.match(backdrop, /padding:\s*0/);
  assert.match(backdrop, /background:\s*var\(--main\)/);
  assert.match(overlay, /width:\s*100vw/);
  assert.match(overlay, /height:\s*100dvh/);
  assert.match(overlay, /border-radius:\s*0/);
  assert.match(overlay, /box-shadow:\s*none/);
});

test('onboarding uses an Orca-like workspace rail and one flat detail pane', () => {
  assert.doesNotMatch(onboardingSource, /onboarding-brand|onboarding-progress-track|className="sr-only"/);
  assert.match(onboardingSource, /onboarding-step-copy/);
  assert.match(onboardingSource, /onboarding-step-state/);

  const layout = cssBlock(onboardingCss, '.onboarding-layout');
  assert.match(layout, /display:\s*grid/);
  assert.match(layout, /grid-template-columns:\s*220px minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(layout, /border-radius|border:\s*1px/);
  const step = cssBlock(onboardingCss, '.onboarding-steps button');
  assert.match(step, /grid-template-columns:\s*20px minmax\(0,\s*1fr\)/);
  assert.match(step, /background:\s*transparent/);
  const active = cssBlock(onboardingCss, '.onboarding-steps button[data-active="true"]');
  assert.match(active, /background:\s*var\(--panel\)/);
  assert.doesNotMatch(active, /accent/);
  assert.doesNotMatch(onboardingCss, /\.app-root:has\(\.onboarding-guide\) \.(?:sidebar|topbar)\s*\{[^}]*display:\s*none/s);
});

test('agent control home is scan-first rows rather than a card wall', () => {
  assert.doesNotMatch(controlRoomSource, /카드를 열어/);
  assert.doesNotMatch(controlRoomSource, /읽기 전용으로 표시합니다/);

  const statusGrid = cssBlock(controlRoomCss, '.agent-status-grid');
  assert.match(statusGrid, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  const statusRow = cssBlock(controlRoomCss, '.agent-status-card');
  assert.match(statusRow, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  assert.match(statusRow, /border-bottom:\s*1px solid var\(--line\)/);
  assert.match(statusRow, /border-radius:\s*0/);
  const automationGrid = cssBlock(controlRoomCss, '.agent-automation-grid');
  assert.match(automationGrid, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  const emptyRow = cssBlock(controlRoomCss, '.agent-control-empty');
  assert.match(emptyRow, /border-bottom:\s*1px solid var\(--line\)/);
  assert.match(emptyRow, /text-align:\s*left/);
  assert.doesNotMatch(emptyRow, /dashed|border-radius:\s*[1-9]/);
});

test('agent control home uses an Orca-like workbench with a narrow execution rail', () => {
  assert.match(controlRoomSource, /className="agent-control-workbench"/);
  assert.match(controlRoomSource, /className="agent-control-primary"/);
  assert.match(controlRoomSource, /className="agent-control-rail"/);
  assert.match(controlRoomSource, /@phosphor-icons\/react/);
  assert.doesNotMatch(controlRoomSource, /↻|›|✓|◷/);

  const workbench = cssBlock(controlRoomCss, '.agent-control-workbench');
  assert.match(workbench, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+320px/);
  assert.match(workbench, /border-top:\s*1px solid var\(--line\)/);

  const primary = cssBlock(controlRoomCss, '.agent-control-primary');
  assert.match(primary, /padding-right:\s*18px/);

  const rail = cssBlock(controlRoomCss, '.agent-control-rail');
  assert.match(rail, /border-left:\s*1px solid var\(--line\)/);
  assert.match(rail, /padding-left:\s*18px/);
  assert.doesNotMatch(rail, /box-shadow|border-radius/);
});

test('runner setup uses neutral tool sections instead of warm card stacks', () => {
  assert.match(runnerSource, /runner-setup/);
  const runnerCard = cssBlock(cssSource, '.runner-card');
  assert.match(runnerCard, /border-bottom:\s*1px solid var\(--line\)/);
  assert.match(runnerCard, /border-radius:\s*0/);
  assert.doesNotMatch(runnerCard, /#fffdfb|box-shadow/);

  const ready = cssBlock(cssSource, '.runner-ready');
  assert.doesNotMatch(ready, /gradient/);
});

test('Telegram continuation is a quiet Work Conversation tool, not a success-colored card', () => {
  assert.match(conversationSource, /Telegram에서 이어가기/);
  assert.match(conversationSource, /Bot token과 chat id는 Runner에만 저장됩니다/);
  assert.match(conversationSource, /수신 소유권 미확인/);
  assert.match(conversationSource, /기존 Hermes poller/);
  assert.match(conversationSource, /data-testid="agent-work-telegram"/);

  const channel = cssBlock(controlRoomCss, '.agent-work-telegram');
  assert.match(channel, /border-top:\s*1px solid var\(--line\)/);
  assert.doesNotMatch(channel, /green|gradient|box-shadow|border-radius/);
});

test('wiki is a compact tool surface without prompt pills or card walls', () => {
  assert.doesNotMatch(wikiSource, /const suggest|wiki-suggest|wiki-obsidian|Obsidian/);
  assert.doesNotMatch(wikiGraphSource, /data-obsidian|Obsidian graph controls|wiki-graph-pane-chrome/);

  const askField = cssBlock(cssSource, '.askbar > div');
  assert.match(askField, /height:\s*40px/);
  assert.match(askField, /border-radius:\s*var\(--radius-control\)/);

  const askButton = cssBlock(cssSource, '.askbar > button');
  assert.match(askButton, /height:\s*40px/);
  assert.doesNotMatch(askButton, /box-shadow|gradient/);

  const answer = cssBlock(cssSource, '.wiki-answer');
  assert.match(answer, /background:\s*var\(--sidebar\)/);
  assert.match(answer, /border-radius:\s*var\(--radius-control\)/);

  const main = cssBlock(cssSource, '.wiki-main');
  assert.match(main, /gap:\s*0/);
  assert.match(main, /border:\s*1px solid var\(--line\)/);

  const graph = cssBlock(cssSource, '.wiki-graph-panel');
  assert.match(graph, /border:\s*0/);
  assert.match(graph, /border-radius:\s*0/);

  const side = cssBlock(cssSource, '.wiki-side');
  assert.match(side, /gap:\s*0/);
  assert.match(side, /border-left:\s*1px solid var\(--line\)/);

  const tree = cssBlock(cssSource, '.tree');
  assert.match(tree, /background:\s*transparent/);
  assert.match(tree, /border:\s*0/);
  assert.match(tree, /border-radius:\s*0/);

  const darkGraph = cssBlock(cssSource, '.app-root[data-theme="dark"] .wiki-main:not([data-graph-focus="true"]) .wiki-graph-bg');
  assert.match(darkGraph, /fill:\s*var\(--main\)/);

  const focus = cssBlock(cssSource, '.wiki[data-graph-focus="true"]');
  assert.match(focus, /width:\s*100%/);
  assert.match(focus, /margin:\s*0/);
  assert.match(focus, /background:\s*var\(--panel\)/);
  assert.match(focus, /border-radius:\s*0/);
  assert.doesNotMatch(focus, /box-shadow|rgba|#[0-9a-f]{3,8}/i);

  const focusMain = cssBlock(cssSource, '.wiki-main[data-graph-focus="true"]');
  assert.match(focusMain, /display:\s*flex/);
  assert.doesNotMatch(focusMain, /grid-template-columns/);
  assert.doesNotMatch(cssSource, /\.wiki-main\[data-graph-focus="true"\]\s+\.wiki-graph-panel\s*>\s*header\s*\{[^}]*display:\s*none/s);

  const graphSettings = cssBlock(cssSource, '.wiki-graph-settings');
  assert.match(graphSettings, /color:\s*var\(--text\)/);
  assert.match(graphSettings, /background:\s*var\(--panel\)/);
  assert.match(graphSettings, /border:\s*1px solid var\(--line\)/);
  assert.match(graphSettings, /border-radius:\s*var\(--radius-control\)/);
  assert.doesNotMatch(graphSettings, /box-shadow|rgba|#[0-9a-f]{3,8}/i);

  const graphControls = cssBlock(cssSource, '.wiki-graph-controls');
  assert.match(graphControls, /background:\s*var\(--panel\)/);
  assert.match(graphControls, /border-radius:\s*var\(--radius-control\)/);
  assert.match(graphControls, /opacity:\s*1/);
  assert.doesNotMatch(graphControls, /box-shadow|rgba|#[0-9a-f]{3,8}/i);

  const graphControlButton = cssBlock(cssSource, '.wiki-graph-controls button');
  assert.match(graphControlButton, /background:\s*transparent/);
  assert.match(graphControlButton, /border-radius:\s*var\(--radius-control\)/);
});

test('anti-slop product surfaces do not reintroduce gradients or oversized shadows', () => {
  const loginStart = cssSource.indexOf('.login-root');
  const settingsEnd = cssSource.indexOf('.run-report', loginStart);
  const focusedCss = cssSource.slice(loginStart, settingsEnd);
  assert.doesNotMatch(focusedCss, /linear-gradient|radial-gradient|0 18px 50px|0 24px 70px/);
});

test('actual Orca polish is one bounded final layer over every primary product surface', async () => {
  assert.match(
    mainSource,
    /import '\.\/styles\.css';\s*import '\.\/orca-product-polish\.css';/,
    'The Orca polish layer must load after every existing product stylesheet',
  );

  const polish = await readFile(new URL('src/orca-product-polish.css', desktopRoot), 'utf8');
  const pureLines = polish
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('/*') && !line.trim().startsWith('*'))
    .length;

  assert.ok(pureLines <= 250, `Polish layer must stay bounded; found ${pureLines} pure lines`);
  assert.doesNotMatch(polish, /linear-gradient|radial-gradient|backdrop-filter/);
  assert.ok(
    [...polish.matchAll(/box-shadow:\s*([^;]+);/g)]
      .every((match) => match[1].trim() === 'none'),
    'The final polish layer may only remove shadows',
  );
  assert.match(polish, /--canvas:\s*#fff/i);
  assert.match(polish, /--sidebar:\s*#fafafa/i);
  assert.match(polish, /--line:\s*#e5e5e5/i);
  assert.match(polish, /--canvas:\s*#0a0a0a/i);
  assert.match(polish, /--sidebar:\s*#171717/i);
  assert.match(polish, /--line:\s*rgb\(255 255 255 \/ \.07\)/i);

  for (const selector of [
    '.sidebar',
    '.topbar',
    '.onboarding-guide',
    '.onboarding-layout',
    '.runner-card',
    '.wiki-main',
    '.settings-section',
  ]) {
    assert.match(polish, new RegExp(selector.replace('.', '\\.')), `Missing ${selector} polish`);
  }

  assert.match(polish, /\.onboarding-layout[\s\S]*border:\s*0/);
  assert.match(polish, /\.runner-card[\s\S]*border-radius:\s*0/);
  assert.match(polish, /\.settings-section[\s\S]*border-radius:\s*0/);
});
