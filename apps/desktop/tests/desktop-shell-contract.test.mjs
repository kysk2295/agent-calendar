import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const electronMainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const entrySource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('desktop shell does not load or render the removed mobile shell', () => {
  // Given: the production renderer entry, app shell, and global styles.
  // When: the desktop-only shell contract is inspected.
  // Then: no mobile navigation or global mobile breakpoint remains.
  assert.doesNotMatch(entrySource, /features\/mobile|responsive(?:-knowledge)?\.css/);
  assert.doesNotMatch(appSource, /MobileNavigation|mobileNavigationItems/);
  assert.doesNotMatch(styleSource, /\.app-root\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(styleSource, /^\.sidebar\s*\{\s*display:\s*none/m);
});

test('Electron main window resets persisted renderer zoom after loading', () => {
  // Given / When / Then
  assert.match(electronMainSource, /did-finish-load[\s\S]*?setZoomFactor\(1\)/);
});
