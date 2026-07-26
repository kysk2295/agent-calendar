import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const appSource = await readFile(new URL('src/App.tsx', desktopRoot), 'utf8');
const cssSource = await readFile(new URL('src/styles.css', desktopRoot), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('package.json', desktopRoot), 'utf8'));

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cssSource.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS block for ${selector}`);
  return match[1];
}

test('desktop navigation uses one outline icon family instead of emoji glyphs', () => {
  assert.ok(packageJson.dependencies['@phosphor-icons/react']);
  assert.match(appSource, /from '@phosphor-icons\/react'/);
  assert.match(appSource, /function NavIcon\(/);
  assert.doesNotMatch(
    appSource.slice(appSource.indexOf('const smartNavGroups'), appSource.indexOf('function arr')),
    /🗓️|☀️|📆|📥|✉️|📊|📚|📔|🤖/,
  );
  assert.match(appSource, /<NavIcon name=\{item\.icon\}/);
});

test('Calendar AI is a compact top-work-bar action instead of a floating gradient circle', () => {
  const topbarStart = appSource.indexOf('<header className="topbar">');
  const topbarEnd = appSource.indexOf('</header>', topbarStart);
  assert.ok(topbarStart >= 0 && topbarEnd > topbarStart);
  const topbarSource = appSource.slice(topbarStart, topbarEnd);
  assert.match(topbarSource, /className="chat-fab"/);
  assert.doesNotMatch(topbarSource, /selectedMeta\.sub/);

  const compactChatFab = cssSource.match(/\n\.chat-fab\s*\{\s*\n\s*position:\s*static;([^}]+)\}/);
  assert.ok(compactChatFab, 'Missing static top-work-bar Calendar AI style');
  assert.match(cssSource, /\.onboarding-return,\s*\n\.chat-fab\s*\{[^}]*height:\s*var\(--control-height\)/);
  assert.doesNotMatch(compactChatFab[0], /linear-gradient|border-radius:\s*50%|box-shadow/);
});

test('shell and Unified Calendar use the documented compact layout tokens', () => {
  const rootTokens = cssBlock(':root');
  assert.match(rootTokens, /--shell-sidebar:\s*220px/);
  assert.match(rootTokens, /--shell-topbar:\s*40px/);
  assert.match(rootTokens, /--control-height:\s*30px/);
  assert.match(rootTokens, /--radius-control:\s*6px/);

  const navActive = cssBlock('.nav-item[data-active="true"]');
  assert.doesNotMatch(navActive, /box-shadow/);

  const calendarSources = cssBlock('.unified-calendar-sources');
  assert.match(calendarSources, /min-height:\s*var\(--control-height\)/);
  assert.match(calendarSources, /border:\s*1px solid var\(--line-soft\)/);
});

test('populated Calendar semantic states use theme-aware owner and source tokens', () => {
  const rootTokens = cssBlock(':root');
  const darkTokens = cssBlock('.app-root[data-theme="dark"]');
  for (const token of [
    '--calendar-personal-text',
    '--calendar-personal-surface',
    '--calendar-agent-text',
    '--calendar-agent-surface',
    '--calendar-hybrid-text',
    '--calendar-google-text',
    '--calendar-google-surface',
    '--calendar-event-text',
    '--calendar-event-surface',
    '--calendar-source-badge-text',
  ]) {
    assert.match(rootTokens, new RegExp(`${token}:`), `Missing light Calendar token ${token}`);
    assert.match(darkTokens, new RegExp(`${token}:`), `Missing dark Calendar token ${token}`);
  }

  assert.match(cssBlock('.owner-agent'), /var\(--calendar-agent-text\).*var\(--calendar-agent-surface\)/s);
  assert.match(cssBlock('.owner-hybrid'), /var\(--calendar-hybrid-text\).*var\(--calendar-hybrid-surface\)/s);
  assert.match(
    cssSource,
    /\.event-pill\.source-google,[^}]+color:\s*var\(--calendar-google-text\);[^}]+background:\s*var\(--calendar-google-surface\)/s,
  );
  assert.match(
    cssBlock('.calendar-event-pill'),
    /color:\s*var\(--calendar-event-text\).*background:\s*var\(--calendar-event-surface\)/s,
  );
});
