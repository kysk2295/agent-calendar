import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

const roster = await vite.ssrLoadModule('/src/domains/agent-work/agentRoster.ts');

test('Agent Work combines roster identity with runtime profile readiness', () => {
  const [agent] = roster.mergeAgentsWithProfileReadiness(
    [{ id: 'wikicurator', displayName: 'Wiki Curator' }],
    { requiredProfiles: [{ profile: 'wikicurator', status: 'ready', present: true }] },
  );
  assert.equal(agent.hermesProfileStatus, 'ready');
  assert.equal(roster.agentStatusLabel(agent), '준비됨');
  assert.equal(roster.isAgentSelectable(agent), true);
});

test('Agent Work keeps missing and pending profiles unselectable', () => {
  assert.equal(roster.isAgentSelectable({ id: 'missing', hermesProfilePresent: false }), false);
  assert.equal(roster.isAgentSelectable({ id: 'pending', pending: true }), false);
  assert.equal(roster.agentStatusLabel({ hermesProfileStatus: 'missing', hermesProfilePresent: false }), '누락');
});

test('Agent Work groups native and connected agents without confusing source with engine', () => {
  const groups = roster.groupAgentDirectory([
    {
      id: 'native',
      displayName: '내 리서처',
      sourceKind: 'native',
      provider: 'agent-calendar',
      defaultExecutionEngine: 'codex',
    },
    {
      id: 'hermes',
      displayName: 'Hermes 리서처',
      sourceKind: 'connected',
      provider: 'hermes',
      externalAgentId: 'researcher',
      defaultExecutionEngine: 'claude',
    },
  ]);

  assert.deepEqual(groups.native.map((agent) => agent.id), ['native']);
  assert.deepEqual(groups.connected.map((agent) => agent.id), ['hermes']);
  assert.equal(roster.agentSourceLabel(groups.native[0]), '사용자 생성');
  assert.equal(roster.agentSourceLabel(groups.connected[0]), 'Hermes 연결');
  assert.equal(roster.agentSourceLabel(groups.connected[0]).includes('Claude'), false);
});

test('connected agent readiness reports Runner requirement honestly', () => {
  const connected = {
    id: 'hermes',
    sourceKind: 'connected',
    provider: 'hermes',
    connectionStatus: 'linked',
  };

  assert.equal(roster.agentConnectionLabel(connected, { runnerConnected: false }), 'Runner 필요');
  assert.equal(roster.isAgentSelectable(connected, { runnerConnected: false }), false);
  assert.equal(roster.agentConnectionLabel(connected, { runnerConnected: true }), '연결됨');
  assert.equal(roster.isAgentSelectable(connected, { runnerConnected: true }), true);
  assert.equal(roster.isAgentSelectable({ id: 'native', sourceKind: 'native' }, { runnerConnected: false }), true);
});
