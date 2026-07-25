import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const appSource = await readFile(new URL('src/App.tsx', desktopRoot), 'utf8');
const cssSource = await readFile(new URL('src/styles.css', desktopRoot), 'utf8');
const onboardingSource = await readFile(
  new URL('src/features/onboarding/OnboardingGuide.tsx', desktopRoot),
  'utf8',
);
const onboardingCss = await readFile(
  new URL('src/features/onboarding/onboarding.css', desktopRoot),
  'utf8',
);

function cssBlocks(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, 'g'))]
    .map((match) => match[1]);
}

function lastCssBlock(source, selector) {
  const blocks = cssBlocks(source, selector);
  assert.ok(blocks.length > 0, `Missing CSS block for ${selector}`);
  return blocks.at(-1);
}

test('shared product controls use quiet neutral actions without decorative elevation', () => {
  const root = lastCssBlock(cssSource, ':root');
  assert.match(root, /--shell-sidebar:\s*220px/);
  assert.match(root, /--shell-topbar:\s*40px/);
  assert.match(root, /--radius-control:\s*6px/);

  const primary = lastCssBlock(cssSource, '.primary');
  assert.match(primary, /background:\s*var\(--action\)/);
  assert.match(primary, /color:\s*var\(--action-text\)/);
  assert.match(primary, /box-shadow:\s*none/);
  assert.doesNotMatch(primary, /linear-gradient|radial-gradient/);
});

test('login is a compact account boundary instead of a generic elevated card', () => {
  const loginStart = appSource.indexOf('function AgentCalendarLoginExperience');
  const loginEnd = appSource.indexOf('function TaskDetailModal', loginStart);
  const login = appSource.slice(loginStart, loginEnd);
  assert.doesNotMatch(login, /일정과 에이전트 작업공간/);
  assert.doesNotMatch(login, /안전한 시스템 브라우저에서 로그인한 뒤 이 앱으로 돌아옵니다/);

  const surfaceStart = cssSource.lastIndexOf('.login-workspace-entry,');
  const surfaceEnd = cssSource.indexOf('}', surfaceStart);
  assert.ok(surfaceStart >= 0 && surfaceEnd > surfaceStart, 'Missing compact login surface');
  const surface = cssSource.slice(surfaceStart, surfaceEnd);
  assert.match(surface, /width:\s*min\(320px,\s*calc\(100vw - 48px\)\)/);
  assert.match(surface, /border:\s*0/);
  assert.match(surface, /border-radius:\s*0/);
  assert.match(surface, /box-shadow:\s*none/);

  const form = lastCssBlock(cssSource, '.login-workspace-entry .login-form');
  assert.match(form, /padding:\s*0/);
  assert.doesNotMatch(cssSource, /\.login-splash|\.splash-orbit|\.orbit-node|\.login-field|\.login-mode-toggle|\.login-divider/);
});

test('onboarding follows Orca workspace-list and single-task hierarchy', () => {
  assert.match(onboardingSource, /onboarding-progress-step/);
  assert.match(onboardingSource, /onboarding-step-copy/);
  assert.match(onboardingSource, /onboarding-step-state/);
  assert.doesNotMatch(onboardingSource, /className="sr-only"|onboarding-brand/);

  const surface = lastCssBlock(onboardingCss, '.onboarding-guide');
  assert.match(surface, /width:\s*100%/);
  assert.match(surface, /height:\s*100%/);
  assert.match(surface, /border:\s*0/);
  assert.match(surface, /box-shadow:\s*none/);

  const layout = lastCssBlock(onboardingCss, '.onboarding-layout');
  assert.match(layout, /grid-template-columns:\s*220px minmax\(0,\s*1fr\)/);

  const heading = lastCssBlock(onboardingCss, '.onboarding-detail-copy h3');
  assert.match(heading, /font-size:\s*16px/);
  assert.doesNotMatch(heading, /clamp/);
});

test('settings keeps Orca density and does not nest oversized content cards', () => {
  assert.equal(
    cssBlocks(cssSource, '.settings-overlay').length,
    1,
    'settings overlay should have one authoritative implementation',
  );

  const overlay = lastCssBlock(cssSource, '.settings-overlay');
  assert.match(overlay, /grid-template-columns:\s*240px minmax\(0,\s*1fr\)/);

  const body = lastCssBlock(cssSource, '.settings-main .settings-body');
  assert.match(body, /padding:\s*24px 28px/);

  const section = lastCssBlock(cssSource, '.settings-section');
  assert.match(section, /width:\s*min\(760px,\s*100%\)/);

  const heading = lastCssBlock(cssSource, '.settings-section-head h3');
  assert.match(heading, /font-size:\s*15px/);

  const account = lastCssBlock(cssSource, '.settings-section .account-box');
  assert.match(account, /border-top:\s*1px solid var\(--line\)/);
  assert.match(account, /border-bottom:\s*1px solid var\(--line\)/);
  assert.match(account, /border-radius:\s*0/);
});

test('widgets use the same quiet token system instead of a decorative showcase', () => {
  const widgetStart = cssSource.indexOf('.widgets-showcase');
  const widgetEnd = cssSource.indexOf('.screen-toolbar', widgetStart);
  assert.ok(widgetStart >= 0 && widgetEnd > widgetStart, 'Missing widget surface styles');
  const widgets = cssSource.slice(widgetStart, widgetEnd);

  assert.match(widgets, /background:\s*var\(--panel\)/);
  assert.match(widgets, /border:\s*1px solid var\(--line\)/);
  assert.match(widgets, /border-radius:\s*var\(--radius-panel\)/);
  assert.doesNotMatch(widgets, /linear-gradient|radial-gradient|backdrop-filter|clip-path/);
  assert.deepEqual(
    [...widgets.matchAll(/box-shadow:\s*([^;]+);/g)].map((match) => match[1].trim()),
    ['none', 'none', 'none', 'none', 'none'],
  );
});

test('theme, status, and board accents are semantic instead of inline hex colors', () => {
  const todayStart = appSource.indexOf('function TodayScreen');
  const todayEnd = appSource.indexOf('function PlanTaskRow', todayStart);
  const today = appSource.slice(todayStart, todayEnd);
  assert.match(today, /data-tone=/);
  assert.doesNotMatch(today, /style=\{\{\s*color:/);

  const kanbanStart = appSource.indexOf('function KanbanScreen');
  const kanbanEnd = appSource.indexOf('function SearchScreen', kanbanStart);
  const kanban = appSource.slice(kanbanStart, kanbanEnd);
  assert.match(kanban, /data-tone=/);
  assert.doesNotMatch(kanban, /style=\{\{\s*background:/);

  const settingsStart = appSource.indexOf('function SettingsOverlay');
  const settingsEnd = appSource.indexOf('function DesktopReleasePanel', settingsStart);
  const settings = appSource.slice(settingsStart, settingsEnd);
  assert.match(settings, /data-theme-swatch=/);
  assert.doesNotMatch(settings, /\['default',\s*'Terracotta',\s*'#[0-9A-Fa-f]{6}'\]/);
});

test('agent work and modal routes share the quiet token and elevation contract', () => {
  const missionIcon = lastCssBlock(cssSource, '.mission header div');
  assert.match(missionIcon, /background:\s*var\(--accent\)/);
  assert.match(missionIcon, /border-radius:\s*var\(--radius-control\)/);
  assert.doesNotMatch(missionIcon, /gradient/);

  const progressTrack = lastCssBlock(cssSource, '.run-row > div');
  const progressValue = lastCssBlock(cssSource, '.run-row > div i');
  assert.match(progressTrack, /background:\s*var\(--line\)/);
  assert.match(progressValue, /background:\s*var\(--accent\)/);
  assert.doesNotMatch(progressValue, /gradient/);

  for (const selector of [
    '.detail-backdrop,\n.delegate-backdrop',
    '.agent-backdrop',
    '.taxonomy-backdrop',
    '.detail-backdrop',
    '.run-backdrop',
    '.plan-backdrop',
  ]) {
    const backdrop = lastCssBlock(cssSource, selector);
    assert.doesNotMatch(backdrop, /backdrop-filter/);
    assert.match(backdrop, /background:\s*color-mix\(in srgb,\s*var\(--action\)/);
  }

  for (const selector of [
    '.detail-modal,\n.delegate-modal,\n.agent-modal',
    '.taxonomy-modal',
    '.detail-modal',
    '.modal',
    '.run-modal,\n.plan-modal',
  ]) {
    const modal = lastCssBlock(cssSource, selector);
    assert.match(modal, /border-radius:\s*var\(--radius-panel\)/);
    assert.match(modal, /box-shadow:\s*none/);
  }

  const detailBottomline = lastCssBlock(cssSource, '.detail-bottomline');
  const detailList = lastCssBlock(cssSource, '.detail-list-pill');
  const detailListIcon = lastCssBlock(cssSource, '.detail-list-pill span');
  const detailListCaret = lastCssBlock(cssSource, '.detail-list-pill b');
  assert.match(detailBottomline, /border-top:\s*1px solid var\(--line\)/);
  assert.match(detailList, /color:\s*var\(--text\)/);
  assert.match(detailListIcon, /color:\s*var\(--muted-dark\)/);
  assert.match(detailListCaret, /color:\s*var\(--muted\)/);

  const completionToast = lastCssBlock(cssSource, '.completion-toast');
  assert.match(completionToast, /background:\s*var\(--panel\)/);
  assert.match(completionToast, /border:\s*1px solid var\(--line-strong\)/);
  assert.match(completionToast, /box-shadow:\s*none/);

  const detailTopline = lastCssBlock(cssSource, '.detail-topline');
  const detailCheck = lastCssBlock(cssSource, '.detail-topline .detail-check');
  const detailDivider = lastCssBlock(cssSource, '.detail-divider');
  const detailDate = lastCssBlock(cssSource, '.detail-date-trigger');
  const detailDatePopover = lastCssBlock(cssSource, '.detail-date-popover');
  const detailDateSegment = lastCssBlock(cssSource, '.detail-date-segment');
  const activeDetailDateSegment = lastCssBlock(
    cssSource,
    '.detail-date-segment button[data-active="true"]',
  );
  assert.match(detailTopline, /border-bottom:\s*1px solid var\(--line\)/);
  assert.match(detailCheck, /background:\s*var\(--input\)/);
  assert.match(detailCheck, /border:\s*1\.5px solid var\(--line-strong\)/);
  assert.match(detailDivider, /background:\s*var\(--line\)/);
  assert.match(detailDate, /color:\s*var\(--accent-dark\)/);
  assert.match(detailDatePopover, /background:\s*var\(--panel\)/);
  assert.match(detailDatePopover, /border:\s*1px solid var\(--line\)/);
  assert.match(detailDatePopover, /box-shadow:\s*none/);
  assert.match(detailDateSegment, /background:\s*var\(--bar\)/);
  assert.match(activeDetailDateSegment, /color:\s*var\(--text\)/);
  assert.match(activeDetailDateSegment, /box-shadow:\s*none/);
});
