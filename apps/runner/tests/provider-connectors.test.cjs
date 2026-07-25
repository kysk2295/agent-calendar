'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createProviderConnector,
  normalizePublicCatalogEntry,
  normalizePublicSessionEntry,
} = require('../lib/provider-connectors');
const { createHermesAutomationConnector } = require('../lib/automation-connectors');
const {
  connectorRequestHash,
  runConnectorOnce,
} = require('../lib/connector-loop');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('local catalog discovery requires explicit consent', async () => {
  const connector = createProviderConnector({
    homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'provider-connectors-consent-')),
  });

  await assert.rejects(
    () => connector.listAgents('codex', { consent: false }),
    (error) => error && error.code === 'CONNECTOR_CONSENT_REQUIRED',
  );
});

test('Codex and Claude local agent files become bounded public metadata only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-connectors-'));
  try {
    write(path.join(root, '.codex', 'agents', 'researcher.toml'), [
      'name = "Researcher"',
      'description = "Checks primary sources"',
      'model = "gpt-secret-model"',
      'api_key = "sk-must-not-leak"',
    ].join('\n'));
    write(path.join(root, '.claude', 'agents', 'reviewer.md'), [
      '---',
      'name: reviewer',
      'description: Reviews changes',
      'model: sonnet',
      'token: must-not-leak',
      '---',
      'Private prompt body at /Users/alice/private/project.',
    ].join('\n'));

    const connector = createProviderConnector({
      homeDir: root,
      codexHome: path.join(root, '.codex'),
      cwd: root,
    });
    const codexEntries = await connector.listAgents('codex', { consent: true });
    const claudeEntries = await connector.listAgents('claude', { consent: true });

    assert.deepEqual(codexEntries, [{
      provider: 'codex',
      externalAgentId: 'researcher',
      displayName: 'Researcher',
      description: 'Checks primary sources',
      sourceKind: 'local_profile',
      capability: 'importable',
    }]);
    assert.deepEqual(claudeEntries, [{
      provider: 'claude',
      externalAgentId: 'reviewer',
      displayName: 'reviewer',
      description: 'Reviews changes',
      sourceKind: 'local_profile',
      capability: 'importable',
    }]);
    assert.doesNotMatch(JSON.stringify({ codexEntries, claudeEntries }), /sk-|must-not-leak|Users|alice|private/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider discovery is isolated by each Runner process provider home', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-homes-'));
  try {
    const codexHomeA = path.join(root, 'runner-a-codex');
    const codexHomeB = path.join(root, 'runner-b-codex');
    write(path.join(codexHomeA, 'agents', 'agent-a.toml'), 'name = "Agent A"\n');
    write(path.join(codexHomeB, 'agents', 'agent-b.toml'), 'name = "Agent B"\n');

    const connectorA = createProviderConnector({
      env: {
        HOME: path.join(root, 'runner-a-home'),
        CODEX_HOME: codexHomeA,
      },
    });
    const connectorB = createProviderConnector({
      env: {
        HOME: path.join(root, 'runner-b-home'),
        CODEX_HOME: codexHomeB,
      },
    });

    const catalogA = await connectorA.listAgents('codex', { consent: true });
    const catalogB = await connectorB.listAgents('codex', { consent: true });
    assert.deepEqual(catalogA.map((entry) => entry.externalAgentId), ['agent-a']);
    assert.deepEqual(catalogB.map((entry) => entry.externalAgentId), ['agent-b']);
    assert.equal(JSON.stringify(catalogA).includes('agent-b'), false);
    assert.equal(JSON.stringify(catalogB).includes('agent-a'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude catalog skips one invalid local entry without hiding valid agents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-connectors-invalid-claude-'));
  try {
    write(path.join(root, '.claude', 'agents', 'invalid.md'), [
      '---',
      'name: token=must-not-leak',
      'description: Invalid private metadata',
      '---',
    ].join('\n'));
    write(path.join(root, '.claude', 'agents', 'reviewer.md'), [
      '---',
      'name: Reviewer',
      'description: Reviews changes',
      '---',
    ].join('\n'));

    const connector = createProviderConnector({
      homeDir: root,
      cwd: root,
    });
    const entries = await connector.listAgents('claude', { consent: true });

    assert.deepEqual(entries.map((entry) => entry.externalAgentId), ['reviewer']);
    assert.doesNotMatch(JSON.stringify(entries), /must-not-leak|token=/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes profile output is normalized without host paths or credentials', async () => {
  const connector = createProviderConnector({
    homeDir: '/Users/alice',
    execFile: async (command, args) => {
      assert.equal(command, 'hermes');
      assert.deepEqual(args, ['profile', 'list']);
      return {
        code: 0,
        stdout: [
          'Profile  Active',
          '-------  ------',
          'default (active) /Users/alice/.hermes',
          'research /Users/alice/.hermes/profiles/research',
          'token=must-not-leak',
        ].join('\n'),
      };
    },
  });

  const entries = await connector.listAgents('hermes', { consent: true });
  assert.deepEqual(entries.map((entry) => entry.externalAgentId), ['default', 'research']);
  assert.doesNotMatch(JSON.stringify(entries), /Users|alice|must-not-leak|token/);
});

test('public catalog projection rejects secret-shaped values', () => {
  assert.throws(
    () => normalizePublicCatalogEntry('codex', {
      id: 'agent-a',
      displayName: 'sk-abcdefghijklmnopqrstuvwxyz123456',
    }),
    (error) => error && error.code === 'CONNECTOR_OUTPUT_SECRET',
  );
});

test('provider session catalogs expose resumable identity without host paths or credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-session-connectors-'));
  try {
    write(
      path.join(root, '.codex', 'sessions', '2026', '07', '25', 'rollout-2026-07-25T10-00-00-00000000-0000-4000-8000-000000000001.jsonl'),
      '{"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-000000000001","cwd":"/Users/alice/private"}}\n',
    );
    write(
      path.join(root, '.claude', 'projects', 'project-a', '00000000-0000-4000-8000-000000000002.jsonl'),
      '{"type":"user","sessionId":"00000000-0000-4000-8000-000000000002","cwd":"/Users/alice/private"}\n',
    );
    const connector = createProviderConnector({
      homeDir: root,
      codexHome: path.join(root, '.codex'),
      cwd: root,
      execFile: async (command, args) => {
        if (command === 'hermes') {
          assert.deepEqual(args, ['sessions', 'list', '--limit', '200']);
          return {
            code: 0,
            stdout: 'Research brief  project-a  2d ago  cli  20260723_120626_3562eb\n',
          };
        }
        assert.equal(command, 'grok');
        assert.deepEqual(args, ['sessions', 'list', '--limit', '200']);
        return {
          code: 0,
          stdout: '019f96b2-9f46-7a03-b008-a1bcaa69e2c3  2026-07-25  2026-07-25  local  Review primary sources\n',
        };
      },
    });

    const codex = await connector.listSessions('codex', { consent: true });
    const claude = await connector.listSessions('claude', { consent: true });
    const hermes = await connector.listSessions('hermes', { consent: true });
    const grok = await connector.listSessions('grok', { consent: true });

    assert.equal(codex[0].externalSessionId, '00000000-0000-4000-8000-000000000001');
    assert.equal(claude[0].externalSessionId, '00000000-0000-4000-8000-000000000002');
    assert.equal(hermes[0].externalSessionId, '20260723_120626_3562eb');
    assert.equal(grok[0].externalSessionId, '019f96b2-9f46-7a03-b008-a1bcaa69e2c3');
    assert.doesNotMatch(JSON.stringify({ codex, claude, hermes, grok }), /Users|alice|private|token|cookie/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public session projection rejects secret-shaped titles', () => {
  assert.throws(
    () => normalizePublicSessionEntry('claude', {
      externalSessionId: '00000000-0000-4000-8000-000000000003',
      title: 'token=must-not-store',
    }),
    (error) => error && error.code === 'CONNECTOR_OUTPUT_SECRET',
  );
});

test('Hermes automation connector keeps endpoint auth local and returns bounded public automation', async () => {
  const requests = [];
  const connector = createHermesAutomationConnector({
    env: {
      AGENT_CALENDAR_HERMES_AUTOMATION_URL: 'http://127.0.0.1:43111',
      AGENT_CALENDAR_HERMES_AUTOMATION_TOKEN: 'runner-local-only',
    },
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init.headers).get('authorization'),
      });
      assert.equal(new URL(url).pathname, '/api/jobs');
      return new Response(JSON.stringify({
        jobs: [{
          id: 'morning-brief',
          name: '아침 브리프',
          schedule: '0 8 * * *',
          enabled: true,
          revision: 'rev-1',
        }],
        cursor: 'cursor-1',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await connector.run('hermes', {
    kind: 'automation_list',
    consent: true,
    cursor: '',
  });
  assert.equal(requests[0].authorization, 'Bearer runner-local-only');
  assert.equal(JSON.stringify(result).includes('runner-local-only'), false);
  assert.deepEqual(result.items, [{
    externalId: 'morning-brief',
    name: '아침 브리프',
    goal: '',
    agentId: '',
    schedule: '0 8 * * *',
    status: 'active',
    enabled: true,
    revision: 'rev-1',
    nextRunAt: '',
    lastRunAt: '',
    lastStatus: '',
  }]);

  const unsafe = createHermesAutomationConnector({
    env: {
      AGENT_CALENDAR_HERMES_AUTOMATION_URL: 'https://automation.example.com',
    },
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(
    () => unsafe.run('hermes', {
      kind: 'automation_capabilities',
      consent: true,
    }),
    (error) => error.code === 'CONNECTOR_AUTOMATION_URL_INVALID',
  );

  const leaking = createHermesAutomationConnector({
    env: {
      AGENT_CALENDAR_HERMES_AUTOMATION_URL: 'http://localhost:43111',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      jobs: [{ id: 'unsafe-job', token: 'must-not-cross-runner-boundary' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    () => leaking.run('hermes', {
      kind: 'automation_list',
      consent: true,
    }),
    (error) => error.code === 'CONNECTOR_OUTPUT_SECRET',
  );
});

test('Hermes loopback API create uses the installed Gateway jobs contract then pauses by exact id', async () => {
  const requests = [];
  const connector = createHermesAutomationConnector({
    env: {
      AGENT_CALENDAR_HERMES_AUTOMATION_URL: 'http://127.0.0.1:43111',
    },
    fetchImpl: async (url, init) => {
      const request = {
        method: init.method,
        path: new URL(url).pathname,
        body: init.body ? JSON.parse(init.body) : null,
      };
      requests.push(request);
      if (request.path === '/api/jobs') {
        return new Response(JSON.stringify({
          job: {
            id: '0123456789ab',
            name: request.body.name,
            schedule: request.body.schedule,
            enabled: true,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        job: {
          id: '0123456789ab',
          name: 'Morning brief',
          schedule: '0 8 * * *',
          enabled: false,
        },
      }), { status: 200 });
    },
  });

  const result = await connector.run('hermes', {
    kind: 'automation_mutation',
    consent: true,
    action: 'create',
    name: 'Morning brief',
    goal: 'Summarize the calendar',
    schedule: '0 8 * * *',
    enabled: false,
  });

  assert.deepEqual(requests, [
    {
      method: 'POST',
      path: '/api/jobs',
      body: {
        name: 'Morning brief',
        prompt: 'Summarize the calendar',
        schedule: '0 8 * * *',
        deliver: 'local',
        enabled: false,
      },
    },
    {
      method: 'POST',
      path: '/api/jobs/0123456789ab/pause',
      body: {},
    },
  ]);
  assert.equal(result.automation.externalId, '0123456789ab');
  assert.equal(result.automation.status, 'paused');
});

test('installed Hermes CLI lists public cron metadata without endpoint configuration', async () => {
  const calls = [];
  const connector = createHermesAutomationConnector({
    env: {},
    execFile: async (command, args) => {
      calls.push({ command, args });
      return {
        code: 0,
        stdout: [
          '\u001b[36mScheduled Jobs\u001b[0m',
          '',
          '  0123456789ab \u001b[32m[active]\u001b[0m',
          '    Name:      Morning brief',
          '    Schedule:  0 8 * * *',
          '    Repeat:    ∞',
          '    Next run:  2026-07-26T23:00:00+00:00',
          '    Deliver:   local',
          '    Script:    /Users/private/never-return.py',
          '    Workdir:   /Users/private/project',
          '    Last run:  2026-07-25T23:00:00+00:00  ok',
        ].join('\n'),
      };
    },
  });

  const result = await connector.run('hermes', {
    kind: 'automation_list',
    consent: true,
  });

  assert.deepEqual(calls, [{
    command: 'hermes',
    args: ['cron', 'list', '--all'],
  }]);
  assert.equal(result.items[0].externalId, '0123456789ab');
  assert.equal(result.items[0].name, 'Morning brief');
  assert.equal(result.items[0].status, 'active');
  assert.equal(result.items[0].lastStatus, 'ok');
  assert.doesNotMatch(JSON.stringify(result), /Users|private|Script|Workdir/);
});

test('installed Hermes CLI creates paused local-delivery jobs and uses current edit/action argv', async () => {
  const calls = [];
  let state = {
    name: 'Morning brief',
    schedule: '0 8 * * *',
    status: 'active',
  };
  const listOutput = () => [
    `  0123456789ab [${state.status}]`,
    `    Name:      ${state.name}`,
    `    Schedule:  ${state.schedule}`,
    '    Repeat:    ∞',
    '    Next run:  2026-07-26T23:00:00+00:00',
    '    Deliver:   local',
  ].join('\n');
  const connector = createHermesAutomationConnector({
    env: {},
    execFile: async (command, args) => {
      calls.push({ command, args });
      if (args[1] === 'create') {
        return {
          code: 0,
          stdout: 'Created job: 0123456789ab\n  Name: Morning brief\n',
        };
      }
      if (args[1] === 'pause') state = { ...state, status: 'paused' };
      if (args[1] === 'edit') {
        state = { name: 'Updated brief', schedule: '0 9 * * *', status: 'paused' };
      }
      if (args[1] === 'resume') state = { ...state, status: 'active' };
      return { code: 0, stdout: args[1] === 'list' ? listOutput() : 'Updated job: 0123456789ab\n' };
    },
  });

  const created = await connector.run('hermes', {
    kind: 'automation_mutation',
    consent: true,
    action: 'create',
    name: 'Morning brief',
    goal: 'Summarize the calendar',
    agentId: 'calendar',
    schedule: '0 8 * * *',
    enabled: false,
  });
  assert.equal(created.automation.status, 'paused');
  assert.equal(created.automation.goal, 'Summarize the calendar');
  assert.equal(created.automation.agentId, 'calendar');
  assert.deepEqual(calls.slice(0, 3), [
    {
      command: 'hermes',
      args: [
        'cron', 'create', '--name', 'Morning brief', '--deliver', 'local',
        '0 8 * * *', 'Summarize the calendar',
      ],
    },
    { command: 'hermes', args: ['cron', 'pause', '0123456789ab'] },
    { command: 'hermes', args: ['cron', 'list', '--all'] },
  ]);

  await connector.run('hermes', {
    kind: 'automation_mutation',
    consent: true,
    action: 'update',
    externalId: '0123456789ab',
    name: 'Updated brief',
    goal: 'Updated prompt',
    schedule: '0 9 * * *',
  });
  await connector.run('hermes', {
    kind: 'automation_mutation',
    consent: true,
    action: 'resume',
    externalId: '0123456789ab',
  });
  await connector.run('hermes', {
    kind: 'automation_mutation',
    consent: true,
    action: 'run',
    externalId: '0123456789ab',
  });
  assert.deepEqual(calls[3], {
    command: 'hermes',
    args: [
      'cron', 'edit', '0123456789ab', '--name', 'Updated brief',
      '--schedule', '0 9 * * *', '--prompt', 'Updated prompt',
    ],
  });
  assert.deepEqual(calls[5], {
    command: 'hermes',
    args: ['cron', 'resume', '0123456789ab'],
  });
  assert.deepEqual(calls[7], {
    command: 'hermes',
    args: ['cron', 'run', '0123456789ab'],
  });
});

test('connector loop completes only the exact Runner request with public entries', async () => {
  const calls = [];
  const client = {
    async deviceRequest(method, requestPath, body) {
      calls.push({ method, requestPath, body });
      if (requestPath === '/api/runner/device/connectors/next') {
        return {
          ok: true,
          request: {
            id: 'connector-a',
            provider: 'codex',
            kind: 'agent_catalog',
            consent: true,
          },
        };
      }
      return { ok: true };
    },
  };
  const connector = {
    async listAgents(provider, options) {
      assert.equal(provider, 'codex');
      assert.equal(options.consent, true);
      return [{
        provider: 'codex',
        externalAgentId: 'researcher',
        displayName: 'Researcher',
        description: '',
        sourceKind: 'local_profile',
        capability: 'importable',
      }];
    },
  };

  const result = await runConnectorOnce(client, { connector });
  assert.equal(result.completed, true);
  const complete = calls.find((call) => call.requestPath === '/api/runner/device/connectors/complete');
  assert.equal(complete.body.requestId, 'connector-a');
  assert.equal(complete.body.entries[0].externalAgentId, 'researcher');
});

test('connector loop dispatches session catalog requests without changing provider session identity', async () => {
  const calls = [];
  const client = {
    async deviceRequest(method, requestPath, body) {
      calls.push({ method, requestPath, body });
      if (requestPath === '/api/runner/device/connectors/next') {
        return {
          ok: true,
          request: {
            id: 'connector-session-a',
            provider: 'claude',
            kind: 'session_catalog',
            consent: true,
          },
        };
      }
      return { ok: true };
    },
  };
  const connector = {
    async listSessions(provider, options) {
      assert.equal(provider, 'claude');
      assert.equal(options.consent, true);
      return [{
        provider: 'claude',
        externalSessionId: '00000000-0000-4000-8000-000000000004',
        title: 'Review session',
        updatedAt: '2026-07-25T10:00:00.000Z',
        status: 'available',
        sourceKind: 'local_session',
        capability: 'resumable',
      }];
    },
  };

  const result = await runConnectorOnce(client, { connector });
  assert.equal(result.completed, true);
  const complete = calls.find((call) => call.requestPath === '/api/runner/device/connectors/complete');
  assert.equal(complete.body.entries[0].externalSessionId, '00000000-0000-4000-8000-000000000004');
});

test('connector loop dispatches Runner-local automation requests and returns only public result', async () => {
  const calls = [];
  const client = {
    state: {},
    persist(patch) {
      this.state = { ...this.state, ...patch };
    },
    async deviceRequest(method, requestPath, body) {
      calls.push({ method, requestPath, body });
      if (requestPath === '/api/runner/device/connectors/next') {
        return {
          ok: true,
          request: {
            id: 'connector-automation-a',
            provider: 'hermes',
            kind: 'automation_mutation',
            consent: true,
            payload: {
              action: 'pause',
              externalId: 'morning-brief',
              expectedRevision: 'rev-1',
              idempotencyKey: 'change-a-1',
            },
          },
        };
      }
      return { ok: true };
    },
  };
  const connector = {
    async runAutomation(provider, input) {
      assert.equal(provider, 'hermes');
      assert.deepEqual(input, {
        kind: 'automation_mutation',
        consent: true,
        action: 'pause',
        externalId: 'morning-brief',
        expectedRevision: 'rev-1',
        idempotencyKey: 'change-a-1',
      });
      return {
        automation: {
          externalId: 'morning-brief',
          name: '아침 브리프',
          status: 'paused',
          enabled: false,
          revision: 'rev-2',
        },
        sourceRevision: 'rev-2',
      };
    },
  };

  const result = await runConnectorOnce(client, { connector });
  assert.equal(result.completed, true);
  const complete = calls.find((call) => call.requestPath === '/api/runner/device/connectors/complete');
  assert.deepEqual(complete.body, {
    requestId: 'connector-automation-a',
    result: {
      automation: {
        externalId: 'morning-brief',
        name: '아침 브리프',
        status: 'paused',
        enabled: false,
        revision: 'rev-2',
      },
      sourceRevision: 'rev-2',
    },
  });
});

test('automation mutation completion replays from Runner journal without repeating provider side effects', async () => {
  const request = {
    id: 'connector-automation-replay',
    provider: 'hermes',
    kind: 'automation_mutation',
    consent: true,
    payload: {
      action: 'pause',
      externalId: 'morning-brief',
      idempotencyKey: 'change-replay-1',
    },
  };
  let completionAttempts = 0;
  let providerCalls = 0;
  const client = {
    state: {},
    persist(patch) {
      this.state = { ...this.state, ...patch };
    },
    async deviceRequest(method, requestPath) {
      if (requestPath === '/api/runner/device/connectors/next') {
        return { ok: true, request };
      }
      if (requestPath === '/api/runner/device/connectors/complete') {
        completionAttempts += 1;
        if (completionAttempts === 1) {
          throw Object.assign(new Error('network unavailable'), { code: 'REQUEST_TIMEOUT' });
        }
      }
      return { ok: true };
    },
  };
  const connector = {
    async runAutomation() {
      providerCalls += 1;
      return {
        automation: {
          externalId: 'morning-brief',
          name: 'Morning brief',
          status: 'paused',
          enabled: false,
        },
      };
    },
  };

  const interrupted = await runConnectorOnce(client, { connector });
  assert.equal(interrupted.deferred, true);
  assert.equal(providerCalls, 1);
  assert.equal(client.state.activeConnectorMutation.status, 'completed');

  const replayed = await runConnectorOnce(client, { connector });
  assert.equal(replayed.completed, true);
  assert.equal(providerCalls, 1);
  assert.equal(client.state.activeConnectorMutation, null);
});

test('started automation journal fails with unknown outcome instead of re-running provider mutation', async () => {
  const request = {
    id: 'connector-automation-uncertain',
    provider: 'hermes',
    kind: 'automation_mutation',
    consent: true,
    payload: {
      action: 'run',
      externalId: 'morning-brief',
      idempotencyKey: 'change-uncertain-1',
    },
  };
  const calls = [];
  const client = {
    state: {
      activeConnectorMutation: {
        requestId: request.id,
        requestHash: connectorRequestHash(request),
        status: 'started',
      },
    },
    persist(patch) {
      this.state = { ...this.state, ...patch };
    },
    async deviceRequest(method, requestPath, body) {
      calls.push({ requestPath, body });
      if (requestPath === '/api/runner/device/connectors/next') {
        return { ok: true, request };
      }
      return { ok: true };
    },
  };
  const connector = {
    async runAutomation() {
      throw new Error('provider mutation must not be repeated');
    },
  };

  const recovered = await runConnectorOnce(client, { connector });
  assert.equal(recovered.failed, true);
  const failure = calls.find((call) => call.requestPath === '/api/runner/device/connectors/fail');
  assert.equal(failure.body.errorCode, 'SOURCE_OUTCOME_UNKNOWN');
  assert.equal(client.state.activeConnectorMutation, null);
});
