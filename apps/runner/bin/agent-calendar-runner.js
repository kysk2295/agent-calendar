#!/usr/bin/env node
'use strict';

/**
 * Agent Calendar Runner CLI
 * Usage:
 *   agent-calendar-runner enroll --base-url URL --code CODE --challenge-id ID
 *   agent-calendar-runner claim-wait --base-url URL
 *   agent-calendar-runner connect --base-url URL
 *   agent-calendar-runner daemon --base-url URL [--capabilities]
 *   agent-calendar-runner rotate --base-url URL
 *   agent-calendar-runner disconnect --base-url URL
 *   agent-calendar-runner status
 */

const path = require('node:path');
const {
  RunnerClient,
  defaultStateDir,
  loadState,
  listKnowledgeSources,
  loadOrCreateIdentity,
  registerKnowledgeSource,
  removeKnowledgeSource,
  formatFingerprint,
  fingerprint,
  PROTOCOL_VERSION,
  RUNNER_VERSION,
} = require('../lib');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  const stateDir = args['state-dir'] || defaultStateDir();
  const baseUrl = args['base-url'] || process.env.AGENT_CALENDAR_API_BASE || '';

  if (command === 'help' || args.help) {
    process.stdout.write(`agent-calendar-runner ${RUNNER_VERSION} (protocol ${PROTOCOL_VERSION})

Commands:
  enroll --base-url URL --challenge-id ID --code CODE
  claim-wait --base-url URL [--timeout-ms N]
  connect --base-url URL
  capabilities --base-url URL
  heartbeat --base-url URL
  knowledge-add --source-id ID --path PATH [--label LABEL]
  knowledge-list
  knowledge-remove --source-id ID
  daemon --base-url URL
  rotate --base-url URL
  disconnect --base-url URL
  status [--state-dir DIR]
`);
    return;
  }

  if (command === 'version') {
    process.stdout.write(`${RUNNER_VERSION}\n`);
    return;
  }

  if (command === 'status') {
    const identity = loadOrCreateIdentity(stateDir);
    const state = loadState(stateDir);
    printJson({
      ok: true,
      runnerVersion: RUNNER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      fingerprint: formatFingerprint(fingerprint(identity.publicKey)),
      stateDir,
      state: {
        runnerId: state.runnerId || null,
        status: state.status || null,
        connectionState: state.connectionState || null,
        hasCredential: Boolean(state.deviceCredential),
        workspaceId: state.workspaceId || null,
      },
    });
    return;
  }

  if (command === 'knowledge-add') {
    const source = registerKnowledgeSource(stateDir, {
      sourceId: args['source-id'] || args.sourceId,
      path: args.path,
      label: args.label,
    });
    printJson({ ok: true, source: { sourceId: source.sourceId, label: source.label } });
    return;
  }

  if (command === 'knowledge-list') {
    printJson({
      ok: true,
      sources: listKnowledgeSources(stateDir).map((source) => ({
        sourceId: source.sourceId,
        label: source.label,
      })),
    });
    return;
  }

  if (command === 'knowledge-remove') {
    const removed = removeKnowledgeSource(stateDir, args['source-id'] || args.sourceId);
    printJson({ ok: true, removed });
    return;
  }

  if (!baseUrl) {
    throw new Error('--base-url is required');
  }

  // Injected probe for tests: AGENT_CALENDAR_RUNNER_PROBE_JSON
  let probeRunner = null;
  if (process.env.AGENT_CALENDAR_RUNNER_PROBE_JSON) {
    const fixed = JSON.parse(process.env.AGENT_CALENDAR_RUNNER_PROBE_JSON);
    probeRunner = async ({ engine }) => fixed.engines?.[engine] || fixed[engine] || {
      available: false,
      status: 'unavailable',
      version: null,
      authStatus: 'missing',
      message: 'not in injected probe',
    };
  }

  const client = new RunnerClient({ baseUrl, stateDir, probeRunner });

  if (command === 'enroll') {
    const result = await client.enroll({
      challengeId: args['challenge-id'] || args.challengeId,
      challengeCode: args.code,
    });
    printJson({ ok: true, phase: 'pending', ...result, fingerprint: client.state.fingerprint });
    return;
  }

  if (command === 'claim-wait' || command === 'enroll-and-claim') {
    if (command === 'enroll-and-claim') {
      await client.enroll({
        challengeId: args['challenge-id'] || args.challengeId,
        challengeCode: args.code,
      });
    }
    const result = await client.enrollAndClaim({
      challengeId: args['challenge-id'] || client.state.challengeId,
      challengeCode: args.code,
      timeoutMs: Number(args['timeout-ms'] || 60_000),
      pollMs: Number(args['poll-ms'] || 400),
    }).catch(async (error) => {
      // enrollAndClaim when already enrolled
      if (client.state.claimToken) {
        const deadline = Date.now() + Number(args['timeout-ms'] || 60_000);
        let last = error;
        while (Date.now() < deadline) {
          try {
            return await client.claim();
          } catch (e) {
            last = e;
            if (e && e.code === 'CLAIM_NOT_CONFIRMABLE') {
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }
            throw e;
          }
        }
        throw last;
      }
      throw error;
    });
    printJson({ ok: true, phase: 'active', runnerId: result.runnerId, credentialVersion: result.credentialVersion });
    return;
  }

  if (command === 'connect') {
    const result = await client.connect();
    printJson({ ok: true, ...result });
    return;
  }

  if (command === 'capabilities') {
    const result = await client.reportCapabilities();
    printJson({ ok: true, ...result });
    return;
  }

  if (command === 'heartbeat') {
    const result = await client.heartbeat();
    printJson({ ok: true, ...result });
    return;
  }

  if (command === 'rotate') {
    const result = await client.rotate();
    printJson({ ok: true, runnerId: result.runnerId, credentialVersion: result.credentialVersion });
    return;
  }

  if (command === 'disconnect') {
    const result = await client.disconnect();
    printJson({ ok: true, ...result });
    return;
  }

  if (command === 'work-once' || command === 'execute-once') {
    const { runOnce, ensureDeviceRequest } = require('../lib/execution-loop');
    ensureDeviceRequest(client);
    // Include fake engine in capability report for test harnesses.
    if (process.env.AGENT_CALENDAR_ALLOW_FAKE_ENGINE === '1') {
      const caps = await client.reportCapabilities().catch(() => null);
      if (caps) {
        await client.deviceRequest('POST', '/api/runner/device/capabilities', {
          engines: {
            ...(caps.capabilities?.engines || {}),
            fake: {
              available: true,
              status: 'available',
              version: 'fake-1',
              authStatus: 'ok',
              message: 'injected fake engine',
            },
          },
        }).catch(() => {});
      }
    }
    const result = await runOnce(client, {
      allowFake: process.env.AGENT_CALENDAR_ALLOW_FAKE_ENGINE === '1',
      forceCrash: Boolean(args['force-crash']),
      forceFail: Boolean(args['force-fail']),
    });
    printJson({ ok: true, ...result });
    return;
  }

  if (command === 'daemon') {
    // enroll if challenge provided
    if (args['challenge-id'] && args.code) {
      await client.enroll({
        challengeId: args['challenge-id'],
        challengeCode: args.code,
      });
      process.stdout.write(`${JSON.stringify({ ok: true, phase: 'pending', runnerId: client.state.runnerId, fingerprint: client.state.fingerprint })}\n`);
      // wait for claim
      const deadline = Date.now() + Number(args['timeout-ms'] || 120_000);
      while (Date.now() < deadline) {
        try {
          await client.claim();
          break;
        } catch (error) {
          if (error && error.code === 'CLAIM_NOT_CONFIRMABLE') {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          throw error;
        }
      }
      if (!client.state.deviceCredential) throw new Error('claim timeout');
      process.stdout.write(`${JSON.stringify({ ok: true, phase: 'claimed', runnerId: client.state.runnerId })}\n`);
    }

    await client.connect();
    process.stdout.write(`${JSON.stringify({ ok: true, phase: 'connected', sessionId: client.state.sessionId })}\n`);
    await client.reportCapabilities();
    process.stdout.write(`${JSON.stringify({ ok: true, phase: 'capabilities', capabilities: client.state.capabilities })}\n`);

    const interval = Number(args['heartbeat-ms'] || 15_000);
    const workPollMs = Number(args['work-poll-ms'] || 1_500);
    const once = Boolean(args.once);
    if (once) return;
    const { runOnce, ensureDeviceRequest } = require('../lib/execution-loop');
    const { runConnectorOnce } = require('../lib/connector-loop');
    ensureDeviceRequest(client);
    let workRunning = false;

    const timer = setInterval(() => {
      client.heartbeat().catch((error) => {
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.code || error.message })}\n`);
      });
    }, interval);
    const workTimer = setInterval(() => {
      if (workRunning) return;
      workRunning = true;
      runConnectorOnce(client).then(() => runOnce(client, {
        allowFake: process.env.AGENT_CALENDAR_ALLOW_FAKE_ENGINE === '1',
      })).catch((error) => {
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.code || error.message })}\n`);
      }).finally(() => {
        workRunning = false;
      });
    }, workPollMs);
    process.on('SIGTERM', async () => {
      clearInterval(timer);
      clearInterval(workTimer);
      try { await client.disconnect(); } catch { /* ignore */ }
      process.exit(0);
    });
    process.on('SIGINT', async () => {
      clearInterval(timer);
      clearInterval(workTimer);
      try { await client.disconnect(); } catch { /* ignore */ }
      process.exit(0);
    });
    await new Promise(() => {});
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.code || 'runner_error', message: error.message })}\n`);
  process.exit(1);
});
