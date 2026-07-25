import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const css = fs.readFileSync(fileURLToPath(new URL('../src/features/agent-operations/agent-workspace.css', import.meta.url)), 'utf8');
const conversationSource = fs.readFileSync(fileURLToPath(new URL('../src/features/agent-operations/AgentWorkConversationView.tsx', import.meta.url)), 'utf8');
const controlHomeSource = fs.readFileSync(fileURLToPath(new URL('../src/features/agent-operations/AgentControlRoomBoard.tsx', import.meta.url)), 'utf8');
const workspaceSource = fs.readFileSync(fileURLToPath(new URL('../src/features/agent-operations/AgentWorkWorkspace.tsx', import.meta.url)), 'utf8');
const detailsSource = fs.readFileSync(fileURLToPath(new URL('../src/features/agent-operations/AgentWorkDetails.tsx', import.meta.url)), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
}

test('Agent Work Control Space uses the documented operational type scale', () => {
  const controlRoom = rule('.agent-control-room');
  const controlTitle = rule('.agent-control-head h1');
  const workTitle = rule('.agent-work-header h1');

  assert.match(controlRoom, /--agent-type-caption:\s*10\.5px/);
  assert.match(controlRoom, /--agent-type-body:\s*12px/);
  assert.match(controlRoom, /--agent-type-screen-title:\s*16px/);
  assert.match(controlRoom, /--agent-type-work-title:\s*16px/);
  assert.match(controlRoom, /--agent-attention-text:/);
  assert.match(controlTitle, /font-size:\s*var\(--agent-type-screen-title\)/);
  assert.match(workTitle, /font-size:\s*var\(--agent-type-work-title\)/);
  assert.doesNotMatch(css, /font-size:[^;}]*!important/);
  assert.match(css, /@media\s*\(max-width:\s*1120px\)[\s\S]*?\.agent-work-layout\s*\{[^}]*display:\s*grid/);
  assert.match(css, /@media\s*\(max-width:\s*480px\)[\s\S]*?\.agent-work-composer\s*>\s*div\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(css, /\.app-root:has\(\.agent-control-room\)\s+\.chat-fab\s*\{[^}]*display:\s*none/);
});

test('in-flow Work Conversation surfaces use borders instead of floating shadows', () => {
  for (const selector of ['.agent-checkpoint', '.agent-work-composer', '.agent-work-details > details']) {
    assert.doesNotMatch(rule(selector), /box-shadow:/, `${selector} must not use a floating shadow`);
  }
});

test('Work Conversation header exposes a scannable status and assignment summary', () => {
  assert.match(conversationSource, /className="agent-work-status-line"/);
  assert.match(conversationSource, /className="agent-work-status-badge"/);
  assert.match(conversationSource, /className="agent-work-assignment"/);
  assert.match(conversationSource, /className="agent-work-attention"/);
  const focusedTitle = rule('.agent-work-header h1:focus-visible');
  assert.match(focusedTitle, /outline:\s*2px\s+solid/);
  assert.doesNotMatch(focusedTitle, /outline:\s*none/);
});

test('Control Home does not render invented progress for work without measured progress', () => {
  assert.doesNotMatch(controlHomeSource, /<i aria-hidden="true" \/>/);
  assert.doesNotMatch(css, /\.agent-running-card\s*>\s*i/);
});

test('work titles and scheduler metadata remain complete instead of clipping operational text', () => {
  const schedulerFooter = rule('.agent-scheduler-card > footer');
  const schedulerValues = rule('.agent-scheduler-card > footer span');
  const runningTitle = rule('.agent-running-card > span strong');
  const recentTitle = rule('.agent-recent-work-card strong');

  assert.doesNotMatch(workspaceSource, /firstLine\.slice\(0, 72\)/);
  assert.match(workspaceSource, /for\s*\(const character of firstLine\)/);
  assert.match(workspaceSource, /prefix\.length \+ character\.length > 297/);
  assert.match(workspaceSource, /title:\s*displayMissionTitle\(rawSelectedBaseMission\.title, rawSelectedBaseMission\.objective\)/);
  assert.match(workspaceSource, /displayMissionTitle\(selectedConversation\.work\.title, selectedConversation\.work\.objective\)/);
  assert.match(workspaceSource, /displayMissionTitle\(mission\.title, mission\.objective\)/);
  assert.match(schedulerFooter, /display:\s*grid/);
  assert.doesNotMatch(schedulerValues, /text-overflow:\s*ellipsis|white-space:\s*nowrap/);
  assert.doesNotMatch(runningTitle, /text-overflow:\s*ellipsis|white-space:\s*nowrap/);
  assert.doesNotMatch(recentTitle, /text-overflow:\s*ellipsis|white-space:\s*nowrap/);
  assert.match(controlHomeSource, /대화 시작됨/);
});

test('minimum-width Work Conversation keeps one timeline scroll owner with the composer in view', () => {
  const narrow = css.match(/@media\s*\(max-width:\s*1120px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(narrow, /\.agent-work-layout\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto[^}]*overflow:\s*hidden/);
  assert.match(narrow, /\.agent-work-primary\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto[^}]*overflow:\s*hidden/);
  assert.match(narrow, /\.agent-work-timeline\s*\{[^}]*overflow:\s*auto/);
  assert.doesNotMatch(narrow, /\.agent-work-layout\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(detailsSource, /matchMedia\('\(min-width: 1121px\)'\)/);
  assert.match(narrow, /\.agent-work-conversation:has\(\.agent-work-details\s*>\s*details\[open\]\)[^{]*\{[^}]*overflow-y:\s*auto/);
  assert.match(narrow, /\.agent-work-conversation:has\(\.agent-work-details\s*>\s*details\[open\]\)\s+\.agent-work-timeline[^{]*\{[^}]*flex:\s*none[^}]*overflow:\s*visible/);
  assert.match(narrow, /\.agent-work-conversation:has\(\.agent-work-state-error\)[^{]*\{[^}]*overflow-y:\s*auto/);
  assert.match(narrow, /\.agent-work-conversation:has\(\.agent-work-state-error\)\s+\.agent-work-timeline\s*\{[^}]*flex:\s*none[^}]*overflow:\s*visible/);
});

test('the Agent Work Control Space takes full reading width at the documented 768px breakpoint', () => {
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.app-root:has\(\.agent-control-room\)\s+\.sidebar\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.agent-work-layout\s*\{[^}]*padding:/);
});

test('narrow and 200 percent zoom viewports preserve room for the conversation timeline', () => {
  const shortZoom = css.match(/@media\s*\(max-width:\s*520px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(shortZoom, /\.agent-work-attention\s*\{[^}]*display:\s*none/);
  assert.match(shortZoom, /\.agent-work-status-line\s+\.agent-work-assignment:last-child\s*\{[^}]*display:\s*none/);
  assert.match(shortZoom, /\.agent-work-kicker\s*\{[^}]*display:\s*none/);
  assert.match(shortZoom, /\.agent-work-back\s+span\s*\{[^}]*display:\s*none/);
  assert.match(shortZoom, /\.agent-work-timeline\s*\{[^}]*min-height:\s*60px/);
});

test('Work Details translates stored deliverable values into operator-facing labels', () => {
  assert.match(detailsSource, /deliverableKindLabel\(props\.mission\.deliverable\.kind\)/);
  assert.match(detailsSource, /deliverableFormatLabel\(props\.mission\.deliverable\.format\)/);
  assert.doesNotMatch(detailsSource, /\{props\.mission\.deliverable\.kind\}\s*·/);
});
