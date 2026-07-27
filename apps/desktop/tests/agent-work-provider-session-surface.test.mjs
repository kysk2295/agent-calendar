import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const conversationSource = await readFile(new URL('src/features/agent-operations/AgentWorkConversationView.tsx', desktopRoot), 'utf8');
const detailsSource = await readFile(new URL('src/features/agent-operations/AgentWorkDetails.tsx', desktopRoot), 'utf8');
const directorySource = await readFile(new URL('src/features/agent-operations/AgentDirectoryPanel.tsx', desktopRoot), 'utf8');
const timelineSource = await readFile(new URL('src/features/agent-operations/AgentWorkTimeline.tsx', desktopRoot), 'utf8');
const composerSource = await readFile(new URL('src/features/agent-operations/AgentWorkComposer.tsx', desktopRoot), 'utf8');
const workspaceSource = await readFile(new URL('src/features/agent-operations/AgentWorkWorkspace.tsx', desktopRoot), 'utf8');
const css = await readFile(new URL('src/features/agent-operations/agent-workspace.css', desktopRoot), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
}

test('Work Conversation is presented as one provider-style session instead of a checkpoint card wall', () => {
  assert.match(conversationSource, /className="agent-work-session-bar"/);
  assert.match(conversationSource, /className="agent-work-session-engine"/);
  assert.doesNotMatch(conversationSource, /className="agent-work-kicker"/);
  assert.match(timelineSource, /function checkpointPresentation/);
  assert.match(timelineSource, /data-presentation=\{presentation\}/);
  assert.doesNotMatch(timelineSource, /className="agent-checkpoint-avatar"/);
  assert.match(rule('.agent-checkpoint[data-presentation="assistant"]'), /background:\s*transparent/);
  assert.match(rule('.agent-checkpoint[data-presentation="assistant"]'), /border:\s*0/);
  assert.match(rule('.agent-checkpoint[data-presentation="activity"]'), /border:\s*0/);
});

test('the session composer uses one frame and explains that follow-ups stay in the same work conversation', () => {
  assert.match(composerSource, /같은 작업 대화에 이어서 보냅니다/);
  assert.match(rule('.agent-work-composer'), /border:\s*1px\s+solid/);
  assert.match(rule('.agent-work-composer textarea'), /border:\s*0/);
  assert.match(rule('.agent-work-composer textarea'), /background:\s*transparent/);
});

test('the session header avoids an automatic focus ring while retaining keyboard focus visibility', () => {
  assert.match(css, /\.agent-work-header h1:focus-visible\s*\{/);
  assert.doesNotMatch(css, /\.agent-work-header h1:focus\s*\{/);
});

test('an empty Work Conversation starts from a message without a manual plan prerequisite', () => {
  assert.doesNotMatch(detailsSource, />계획 만들기</);
  assert.doesNotMatch(detailsSource, /<strong>실행 계획<\/strong>/);
  assert.match(detailsSource, /props\.tasks\.length > 0/);
  assert.match(conversationSource, /첫 지시를 남기면 담당 에이전트가 바로 시작합니다/);
});

test('a selected work uses a focused session rail and one dominant conversation canvas', () => {
  assert.match(workspaceSource, /sessionsOnly/);
  assert.match(directorySource, /readonly sessionsOnly:\s*boolean/);
  assert.match(directorySource, /data-mode=\{props\.sessionsOnly \? 'sessions' : 'directory'\}/);
  assert.match(conversationSource, /AgentWorkDetails/);
  assert.doesNotMatch(detailsSource, />작업 중단</);
  assert.match(rule('.agent-work-layout'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('Work Details shows server-owned current and historical effective configuration', () => {
  assert.match(detailsSource, /현재 유효 구성/);
  assert.match(detailsSource, /이 실행의 구성 기록/);
  assert.match(detailsSource, /snapshotId/);
  assert.match(detailsSource, /기본 거부/);
  assert.match(conversationSource, /effectiveConfiguration=\{props\.conversation\?\.effectiveConfiguration/);
});

test('user messages are compact bubbles while assistant responses stay in the reading flow', () => {
  const userBubble = rule('.agent-checkpoint[data-presentation="user"]');
  assert.match(userBubble, /width:\s*fit-content/);
  assert.match(userBubble, /max-width:\s*min\(78%,\s*620px\)/);
  assert.match(userBubble, /border:\s*0/);
  assert.match(rule('.agent-checkpoint[data-presentation="user"] > header'), /display:\s*none/);
  assert.doesNotMatch(timelineSource, /agent-checkpoint-avatar/);
  assert.match(rule('.agent-checkpoint[data-presentation="assistant"]'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('delivery feedback stays a quiet inline receipt instead of a full-width status banner', () => {
  const feedback = rule('.agent-work-delivery, .agent-work-message-error');
  assert.match(feedback, /right:\s*auto/);
  assert.match(feedback, /max-width:\s*calc\(100% - 24px\)/);
  assert.match(rule('.agent-work-delivery'), /background:\s*var\(--panel\)/);
});

test('completed checkpoints use the neutral result frame without a decorative success rail', () => {
  const result = rule('.agent-checkpoint[data-presentation="result"]');
  assert.doesNotMatch(result, /border-left/);
  assert.doesNotMatch(result, /var\(--green\)/);
  assert.doesNotMatch(
    css,
    /\.agent-checkpoint\[data-presentation="result"\]\s*\{[^}]*var\(--green\)/s,
  );
});

test('one execution reads as a flat result-first run with its raw checkpoints collapsed', () => {
  assert.match(timelineSource, /function groupExecutionCheckpoints/);
  assert.match(timelineSource, /className="agent-checkpoint-run"/);
  assert.match(timelineSource, /className="agent-checkpoint-trace"/);
  assert.match(timelineSource, /<summary>실행 기록 \{supporting\.length\}개<\/summary>/);
  assert.match(rule('.agent-checkpoint-run'), /background:\s*transparent/);
  assert.match(rule('.agent-checkpoint-run'), /border-top:\s*1px\s+solid/);
  assert.match(rule('.agent-checkpoint-run'), /border-radius:\s*0/);
  assert.match(rule('.agent-checkpoint[data-presentation="result"]'), /background:\s*transparent/);
  assert.match(rule('.agent-checkpoint[data-presentation="result"]'), /border:\s*0/);
  assert.match(rule('.agent-checkpoint[data-presentation="activity"]'), /border:\s*0/);
});

test('engine comparison uses compact neutral toggles instead of oversized native checkboxes', () => {
  const input = rule('.agent-work-comparison-targets input');
  const selected = rule('.agent-work-comparison-targets label:has(input:checked)');
  assert.match(input, /position:\s*absolute/);
  assert.match(input, /opacity:\s*0/);
  assert.match(input, /min-width:\s*1px/);
  assert.match(input, /min-height:\s*1px/);
  assert.match(selected, /background:\s*var\(--text\)/);
  assert.match(selected, /border-color:\s*var\(--text\)/);
  assert.doesNotMatch(selected, /accent|green|red|success/i);
});
