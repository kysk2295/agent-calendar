import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const conversationSource = await readFile(new URL('src/features/agent-operations/AgentWorkConversationView.tsx', desktopRoot), 'utf8');
const timelineSource = await readFile(new URL('src/features/agent-operations/AgentWorkTimeline.tsx', desktopRoot), 'utf8');
const composerSource = await readFile(new URL('src/features/agent-operations/AgentWorkComposer.tsx', desktopRoot), 'utf8');
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
  assert.match(timelineSource, /className="agent-checkpoint-avatar"/);
  assert.match(rule('.agent-checkpoint[data-presentation="assistant"]'), /background:\s*transparent/);
  assert.match(rule('.agent-checkpoint[data-presentation="assistant"]'), /border:\s*0/);
  assert.match(rule('.agent-checkpoint[data-presentation="activity"]'), /border-left:\s*1px\s+solid/);
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
