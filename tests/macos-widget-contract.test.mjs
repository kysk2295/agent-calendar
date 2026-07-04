import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');

test('native macOS WidgetKit project exists with four Hermes widgets', () => {
  assert.equal(existsSync(new URL('macos/HermesWidgetHost/HermesWidgetHost.xcodeproj/project.pbxproj', root)), true);
  const widgetSource = source('macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift');
  assert.match(widgetSource, /import WidgetKit/);
  assert.match(widgetSource, /struct HermesMonthCalendarWidget:\s*Widget/);
  assert.match(widgetSource, /struct HermesTodayWidget:\s*Widget/);
  assert.match(widgetSource, /struct HermesNextEventWidget:\s*Widget/);
  assert.match(widgetSource, /struct HermesAgentStatusWidget:\s*Widget/);
  assert.match(widgetSource, /supportedFamilies\(\[\.systemLarge\]\)/);
  assert.match(widgetSource, /supportedFamilies\(\[\.systemMedium\]\)/);
  assert.match(widgetSource, /supportedFamilies\(\[\.systemSmall\]\)/);
  assert.equal((widgetSource.match(/\.contentMarginsDisabled\(\)/g) || []).length >= 4, true);
});

test('native widget views mirror the Hermes handoff visual system', () => {
  const widgetSource = source('macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift');
  const projectSource = source('macos/HermesWidgetHost/HermesWidgetHost.xcodeproj/project.pbxproj');
  assert.match(widgetSource, /#D7613D/);
  assert.doesNotMatch(widgetSource, /Image\("AgentCalendarLogo"\)/);
  assert.match(projectSource, /Assets\.xcassets in Resources/);
  assert.doesNotMatch(widgetSource, /Text\("H"\)/);
  assert.match(widgetSource, /HermesMountainBackground/);
  assert.match(widgetSource, /MonthCalendarWidgetView/);
  assert.match(widgetSource, /TodayWidgetView/);
  assert.match(widgetSource, /NextEventWidgetView/);
  assert.match(widgetSource, /AgentStatusWidgetView/);
});

test('native widgets share a snapshot schema and expose inline widget interactions', () => {
  const sharedSource = source('macos/HermesWidgetHost/Shared/HermesWidgetSnapshot.swift');
  const widgetSource = source('macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift');
  const hostSource = source('macos/HermesWidgetHost/HermesWidgetHost/HermesWidgetHostApp.swift');
  const hostInfoPlist = source('macos/HermesWidgetHost/HermesWidgetHost/Info.plist');
  assert.match(sharedSource, /struct HermesWidgetSnapshot:\s*Codable/);
  assert.match(sharedSource, /static let appGroupID/);
  assert.match(sharedSource, /static let snapshotFileName/);
  assert.match(sharedSource, /static let actionsFileName/);
  assert.match(sharedSource, /struct HermesWidgetAction:\s*Codable/);
  assert.match(sharedSource, /static func enqueueAction/);
  assert.match(sharedSource, /dateDecodingStrategy = \.iso8601/);
  assert.match(sharedSource, /sampleDesignSnapshot/);
  assert.match(sharedSource, /emptySnapshot/);
  assert.match(widgetSource, /struct ToggleHermesTaskIntent:\s*AppIntent/);
  assert.match(widgetSource, /struct OpenHermesDateIntent:\s*AppIntent/);
  assert.match(widgetSource, /struct OpenHermesScreenIntent:\s*AppIntent/);
  assert.match(widgetSource, /struct OpenHermesTaskIntent:\s*AppIntent/);
  assert.match(widgetSource, /HermesWidgetStore\.enqueueAction/);
  assert.match(widgetSource, /WidgetCenter\.shared\.reloadAllTimelines/);
  assert.doesNotMatch(widgetSource, /\.widgetURL\(/);
  assert.doesNotMatch(widgetSource, /hermes:\/\//);
  assert.doesNotMatch(hostSource, /onOpenURL[\s\S]*NSWorkspace\.shared\.open\(url\)/);
  assert.doesNotMatch(hostInfoPlist, /CFBundleURLTypes|CFBundleURLSchemes|hermes/);
});

test('electron consumes native widget actions and persists them to the API', () => {
  const appSource = source('src/App.tsx');
  const mainSource = source('electron/main.ts');
  const preloadSource = source('electron/preload.ts');
  const runtimePreloadSource = source('electron/preload.cts');
  const typeSource = source('src/vite-env.d.ts');
  assert.match(mainSource, /WIDGET_ACTIONS_FILE/);
  assert.match(mainSource, /widget:actions-read/);
  assert.match(mainSource, /widget:actions-clear/);
  assert.match(mainSource, /widget:actions-available/);
  assert.match(mainSource, /startWidgetActionBridge/);
  assert.match(preloadSource, /readWidgetActions/);
  assert.match(preloadSource, /onWidgetActionsAvailable/);
  assert.match(runtimePreloadSource, /readWidgetActions/);
  assert.match(runtimePreloadSource, /onWidgetActionsAvailable/);
  assert.match(typeSource, /interface HermesWidgetAction/);
  assert.match(typeSource, /readWidgetActions\(\): Promise<HermesWidgetAction\[\]>/);
  assert.match(typeSource, /onWidgetActionsAvailable\(callback: \(\) => void\): \(\) => void/);
  assert.match(appSource, /function handleWidgetAction/);
  assert.match(appSource, /function drainWidgetActions/);
  assert.match(appSource, /hermesApi\.updateTask\(id,\s*taskPayload\(snapshot\)\)/);
  assert.match(appSource, /window\.hermesDesktop\?\.readWidgetActions/);
  assert.match(appSource, /window\.hermesDesktop\?\.clearWidgetActions/);
  assert.match(appSource, /onWidgetActionsAvailable/);
  assert.match(appSource, /case 'toggleTask'/);
  assert.match(appSource, /case 'openDate'/);
  assert.match(appSource, /case 'openScreen'/);
});

test('native widgets never show design sample data as real persisted data', () => {
  const sharedSource = source('macos/HermesWidgetHost/Shared/HermesWidgetSnapshot.swift');
  const hostSource = source('macos/HermesWidgetHost/HermesWidgetHost/HermesWidgetHostApp.swift');
  const contentSource = source('macos/HermesWidgetHost/HermesWidgetHost/ContentView.swift');
  const widgetSource = source('macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift');
  const loadBody = sharedSource.match(/static func load\(\) -> HermesWidgetSnapshot \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(loadBody, /return \.emptySnapshot/);
  assert.doesNotMatch(loadBody, /sampleDesignSnapshot/);
  assert.doesNotMatch(hostSource, /HermesWidgetStore\.save\(\.sampleDesignSnapshot\)/);
  assert.doesNotMatch(hostSource, /sampleDesignSnapshot/);
  assert.doesNotMatch(contentSource, /HermesWidgetStore\.save\(\.sampleDesignSnapshot\)/);
  assert.match(widgetSource, /placeholder\(in context: Context\)[\s\S]*sampleDesignSnapshot/);
});

test('native widget host cannot create repeated windows when launched from widget clicks', () => {
  const hostSource = source('macos/HermesWidgetHost/HermesWidgetHost/HermesWidgetHostApp.swift');
  assert.doesNotMatch(hostSource, /WindowGroup\s*\{/);
  assert.match(hostSource, /NSApplicationDelegateAdaptor/);
  assert.match(hostSource, /setActivationPolicy\(\.prohibited\)/);
  assert.match(hostSource, /terminate\(nil\)/);
  assert.match(hostSource, /Settings\s*\{/);
});

test('electron app writes native widget snapshots into the shared app group container', () => {
  const appSource = source('src/App.tsx');
  const mainSource = source('electron/main.ts');
  const preloadSource = source('electron/preload.ts');
  const runtimePreloadSource = source('electron/preload.cts');
  const typeSource = source('src/vite-env.d.ts');
  assert.match(appSource, /function buildHermesWidgetSnapshot/);
  assert.match(appSource, /function normalizeCalendarEvent/);
  assert.match(appSource, /nestedItem\(item,\s*'event',\s*'calendarEvent',\s*'task'\)/);
  assert.match(appSource, /arr\(eventsPayload,\s*'events',\s*'calendarEvents'\)\.map\(normalizeCalendarEvent\)/);
  assert.match(appSource, /window\.hermesDesktop\?\.saveWidgetSnapshot/);
  assert.match(mainSource, /widget:snapshot-save/);
  assert.match(mainSource, /preload\.cjs/);
  assert.match(mainSource, /group\.com\.agents\.calendar/);
  assert.match(mainSource, /HermesWidgetSnapshot\.json/);
  assert.match(mainSource, /changed:\s*previous !== body/);
  assert.doesNotMatch(mainSource, /open.*Hermes Widgets\.app|refreshNativeWidgets|execFile/);
  assert.match(preloadSource, /saveWidgetSnapshot/);
  assert.match(runtimePreloadSource, /saveWidgetSnapshot/);
  assert.match(typeSource, /saveWidgetSnapshot\(snapshot: HermesWidgetSnapshotPayload\): Promise<\{ ok: boolean; path: string; changed: boolean \}>/);
});
