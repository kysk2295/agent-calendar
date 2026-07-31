'use strict';

const fs = require('node:fs');

const { runTelegramChannelOnce } = require('../../lib/telegram-channel');

const stateDir = process.env.TELEGRAM_FIXTURE_STATE_DIR;
const scenarioPath = process.env.TELEGRAM_FIXTURE_SCENARIO_PATH;
const crashBoundary = process.env.TELEGRAM_FIXTURE_CRASH_BOUNDARY || '';

function loadScenario() {
  return JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
}

function saveScenario(value) {
  const temporaryPath = `${scenarioPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, scenarioPath);
}

const client = {
  stateDir,
  deviceRequest: async (_method, requestPath, body) => {
    const scenario = loadScenario();
    scenario.devicePaths.push(requestPath);
    if (requestPath.endsWith('/bind')) {
      saveScenario(scenario);
      return { ok: true, endpoint: { id: 'channel_process_fixture' } };
    }
    if (requestPath.endsWith('/status')) {
      saveScenario(scenario);
      return { ok: true };
    }
    if (requestPath.endsWith('/next')) {
      if (scenario.deliveryStatus === 'unclaimed') {
        scenario.deliveryStatus = 'claimed';
        saveScenario(scenario);
        return {
          ok: true,
          delivery: {
            receiptId: 'receipt_process_fixture',
            eventId: 'event_process_fixture',
            sequence: 11,
            kind: 'completion',
            text: 'process restart answer',
            status: 'claimed',
          },
        };
      }
      if (scenario.deliveryStatus === 'sending') {
        scenario.deliveryStatus = 'delivery_unknown';
        scenario.deliveryUnknownTransitions += 1;
        saveScenario(scenario);
        return {
          ok: true,
          delivery: null,
          deliveryUnknown: {
            receiptId: 'receipt_process_fixture',
            eventId: 'event_process_fixture',
            sequence: 11,
            status: 'delivery_unknown',
          },
        };
      }
      saveScenario(scenario);
      return { ok: true, delivery: null };
    }
    if (requestPath.endsWith('/begin')) {
      scenario.deliveryStatus = 'sending';
      saveScenario(scenario);
      return { ok: true, status: 'sending' };
    }
    if (requestPath.endsWith('/ack')) {
      scenario.deliveryStatus = body.outcome;
      if (body.outcome === 'delivery_unknown') scenario.unknownAcks += 1;
      if (body.outcome === 'delivered') scenario.deliveredAcks += 1;
      saveScenario(scenario);
      return { ok: true, status: body.outcome, sequence: body.sequence };
    }
    throw new Error(`unexpected ${requestPath}`);
  },
};

const fetchImpl = async (url) => {
  const scenario = loadScenario();
  if (String(url).includes('/sendMessage')) scenario.sendCalls += 1;
  saveScenario(scenario);
  return new Response(JSON.stringify({
    ok: true,
    result: String(url).includes('/getUpdates') ? [] : { message_id: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

runTelegramChannelOnce(client, {
  fetchImpl,
  onBoundary: async (name) => {
    if (name === crashBoundary) {
      process.stdout.write(`${JSON.stringify({ ok: false, crashedAt: name, pid: process.pid })}\n`);
      process.exit(86);
    }
  },
}).then((result) => {
  process.stdout.write(`${JSON.stringify({ ...result, pid: process.pid })}\n`);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error?.code || 'fixture_error',
    message: String(error?.message || error),
  })}\n`);
  process.exitCode = 1;
});
