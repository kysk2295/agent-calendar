import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const widgetRoot = new URL('../../widget/', import.meta.url);
const desktopSource = (path) => readFileSync(new URL(path, desktopRoot), 'utf8');
const widgetSource = (path) => readFileSync(new URL(path, widgetRoot), 'utf8');

test('native macOS WidgetKit project exists with four Hermes widgets', () => {
  assert.equal(existsSync(new URL('macos/HermesWidgetHost/HermesWidgetHost.xcodeproj/project.pbxproj', widgetRoot)), true);
  const widgetSwift = widgetSource('macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift');
  assert.match(widgetSwift, /import WidgetKit/);
  assert.match(widgetSwift, /struct HermesMonthCalendarWidget:\s*Widget/);
  assert.match(widgetSwift, /struct HermesTodayWidget:\s*Widget/);
  assert.match(widgetSwift, /struct HermesNextEventWidget:\s*Widget/);
  assert.match(widgetSwift, /struct HermesAgentStatusWidget:\s*Widget/);
  assert.match(widgetSwift, /supportedFamilies\(\[\.systemLarge\]\)/);
  assert.match(widgetSwift, /supportedFamilies\(\[\.systemMedium\]\)/);
  assert.match(widgetSwift, /supportedFamilies\(\[\.systemSmall\]\)/);
  assert.equal((widgetSwift.match(/\.contentMarginsDisabled\(\)/g) || []).length >= 4, true);
});

test('native widget views mirror the Hermes handoff visual system', () => {
  const widgetSwift = widgetSource('macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift');
  const projectSource = widgetSource('macos/HermesWidgetHost/HermesWidgetHost.xcodeproj/project.pbxproj');
  assert.match(widgetSwift, /#D7613D/);
  assert.doesNotMatch(widgetSwift, /Image\("AgentCalendarLogo"\)/);
  assert.match(projectSource, /Assets\.xcassets in Resources/);
  assert.doesNotMatch(widgetSwift, /Text\("H"\)/);
  assert.match(widgetSwift, /HermesMountainBackground/);
  assert.match(widgetSwift, /MonthCalendarWidgetView/);
  assert.match(widgetSwift, /TodayWidgetView/);
  assert.match(widgetSwift, /NextEventWidgetView/);
  assert.match(widgetSwift, /AgentStatusWidgetView/);
});

test('native widgets share a snapshot schema and expose inline widget interactions', () => {
  const sharedSource = widgetSource('macos/HermesWidgetHost/Shared/HermesWidgetSnapshot.swift');
  const widgetSwift = widgetSource('macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift');
  const hostSource = widgetSource('macos/HermesWidgetHost/HermesWidgetHost/HermesWidgetHostApp.swift');
  const hostInfoPlist = widgetSource('macos/HermesWidgetHost/HermesWidgetHost/Info.plist');
  assert.match(sharedSource, /struct HermesWidgetSnapshot:\s*Codable/);
  assert.match(sharedSource, /static let appGroupID/);
  assert.match(sharedSource, /static let snapshotFileName/);
  assert.match(sharedSource, /static let actionsFileName/);
  assert.match(sharedSource, /struct HermesWidgetAction:\s*Codable/);
  assert.match(sharedSource, /static func enqueueAction/);
  assert.match(sharedSource, /dateDecodingStrategy = \.iso8601/);
  assert.match(sharedSource, /sampleDesignSnapshot/);
  assert.match(sharedSource, /emptySnapshot/);
  assert.match(widgetSwift, /struct ToggleHermesTaskIntent:\s*AppIntent/);
  assert.match(widgetSwift, /struct OpenHermesDateIntent:\s*AppIntent/);
  assert.match(widgetSwift, /struct OpenHermesScreenIntent:\s*AppIntent/);
  assert.match(widgetSwift, /struct OpenHermesTaskIntent:\s*AppIntent/);
  assert.match(widgetSwift, /HermesWidgetStore\.enqueueAction/);
  assert.match(widgetSwift, /WidgetCenter\.shared\.reloadAllTimelines/);
  assert.doesNotMatch(widgetSwift, /\.widgetURL\(/);
  assert.doesNotMatch(widgetSwift, /hermes:\/\//);
  assert.doesNotMatch(hostSource, /onOpenURL[\s\S]*NSWorkspace\.shared\.open\(url\)/);
  assert.doesNotMatch(hostInfoPlist, /CFBundleURLTypes|CFBundleURLSchemes|hermes/);
});

test('electron consumes native widget actions and persists them to the API', () => {
  const appSource = desktopSource('src/App.tsx');
  const mainSource = desktopSource('electron/main.ts');
  const preloadSource = desktopSource('electron/preload.ts');
  const runtimePreloadSource = desktopSource('electron/preload.cts');
  const typeSource = desktopSource('src/vite-env.d.ts');
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
  const sharedSource = widgetSource('macos/HermesWidgetHost/Shared/HermesWidgetSnapshot.swift');
  const hostSource = widgetSource('macos/HermesWidgetHost/HermesWidgetHost/HermesWidgetHostApp.swift');
  const contentSource = widgetSource('macos/HermesWidgetHost/HermesWidgetHost/ContentView.swift');
  const widgetSwift = widgetSource('macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift');
  const loadBody = sharedSource.match(/static func load\(\) -> HermesWidgetSnapshot \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(loadBody, /return \.emptySnapshot/);
  assert.doesNotMatch(loadBody, /sampleDesignSnapshot/);
  assert.doesNotMatch(hostSource, /HermesWidgetStore\.save\(\.sampleDesignSnapshot\)/);
  assert.doesNotMatch(hostSource, /sampleDesignSnapshot/);
  assert.doesNotMatch(contentSource, /HermesWidgetStore\.save\(\.sampleDesignSnapshot\)/);
  assert.match(widgetSwift, /placeholder\(in context: Context\)[\s\S]*sampleDesignSnapshot/);
});

test('native widget host cannot create repeated windows when launched from widget clicks', () => {
  const hostSource = widgetSource('macos/HermesWidgetHost/HermesWidgetHost/HermesWidgetHostApp.swift');
  assert.doesNotMatch(hostSource, /WindowGroup\s*\{/);
  assert.match(hostSource, /NSApplicationDelegateAdaptor/);
  assert.match(hostSource, /setActivationPolicy\(\.prohibited\)/);
  assert.match(hostSource, /terminate\(nil\)/);
  assert.match(hostSource, /Settings\s*\{/);
});

test('electron app writes native widget snapshots into the shared app group container', () => {
  const appSource = desktopSource('src/App.tsx');
  const workManagementSource = desktopSource('src/domains/work-management/workManagement.ts');
  const mainSource = desktopSource('electron/main.ts');
  const preloadSource = desktopSource('electron/preload.ts');
  const runtimePreloadSource = desktopSource('electron/preload.cts');
  const typeSource = desktopSource('src/vite-env.d.ts');
  assert.match(appSource, /function buildHermesWidgetSnapshot/);
  assert.match(workManagementSource, /function normalizeCalendarEvent/);
  assert.match(workManagementSource, /nestedItem\(item,\s*'event',\s*'calendarEvent',\s*'task'\)/);
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
