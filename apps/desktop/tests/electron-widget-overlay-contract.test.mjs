import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');

test('electron gates the floating widget overlay behind an explicit opt-in flag', () => {
  const mainSource = source('electron/main.ts');
  assert.match(mainSource, /let widgetOverlayWindow:\s*BrowserWindow \| null = null/);
  assert.match(mainSource, /function shouldCreateWidgetOverlay\(\)[\s\S]*process\.env\.HERMES_WIDGET_OVERLAY === '1'/);
  assert.match(mainSource, /if \(shouldCreateWidgetOverlay\(\)\) createWidgetOverlayWindow\(\);/);
  assert.doesNotMatch(mainSource, /startWidgetActionBridge\(\);\n\s*createWidgetOverlayWindow\(\);/);
  assert.match(mainSource, /function createWidgetOverlayWindow\(\)/);
  assert.match(mainSource, /transparent:\s*true/);
  assert.match(mainSource, /focusable:\s*false/);
  assert.match(mainSource, /skipTaskbar:\s*true/);
  assert.match(mainSource, /backgroundColor:\s*'#00000000'/);
  assert.match(mainSource, /setAlwaysOnTop\(true,\s*'floating'\)/);
  assert.match(mainSource, /setVisibleOnAllWorkspaces\(true,\s*\{\s*visibleOnFullScreen:\s*true\s*\}\)/);
  assert.match(mainSource, /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/);
  assert.match(mainSource, /showInactive\(\)/);
  assert.match(mainSource, /overlayUrl\(devServerUrl\)/);
  assert.match(mainSource, /query:\s*\{\s*overlay:\s*'widgets'\s*\}/);
});

test('renderer overlay mode renders only planned widgets on a transparent surface', () => {
  const appSource = source('src/App.tsx');
  const styleSource = source('src/styles.css');
  assert.match(appSource, /IS_WIDGET_OVERLAY[\s\S]*URLSearchParams\(window\.location\.search\)\.get\('overlay'\) === 'widgets'/);
  assert.match(appSource, /document\.documentElement\.dataset\.overlay = 'widgets'/);
  assert.match(appSource, /if \(isWidgetOverlay\) return;/);
  assert.match(appSource, /className="app-root widget-overlay-root"/);
  assert.match(appSource, /<WidgetsScreen tasks=\{tasks\} events=\{events\} runs=\{runs\} \/>/);
  assert.match(styleSource, /html\[data-overlay="widgets"\][\s\S]*background:\s*transparent/);
  assert.match(styleSource, /\.widget-overlay-root[\s\S]*pointer-events:\s*none/);
  assert.match(styleSource, /\.widget-overlay-root \.widgets-title[\s\S]*display:\s*none/);
  assert.match(styleSource, /\.widget-overlay-root \.widget-card[\s\S]*background:\s*var\(--panel\)/);
  assert.match(styleSource, /\.widget-overlay-root \.widget-card[\s\S]*border:\s*1px solid var\(--line-strong\)/);
  assert.match(styleSource, /\.widget-overlay-root \.widget-card[\s\S]*box-shadow:\s*none/);
  assert.match(styleSource, /\.widget-overlay-root \.widget-month-grid[\s\S]*border-top/);
  assert.match(styleSource, /\.widget-overlay-root \.widget-day\[data-today="true"\] > span[\s\S]*background:\s*var\(--accent\)/);
});
