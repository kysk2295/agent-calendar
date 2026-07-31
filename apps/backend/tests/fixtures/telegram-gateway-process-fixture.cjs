'use strict';

const { Pool } = require('pg');

const {
  WorkConversationChannelService,
} = require('../../app/lib/work-conversation-channel-service');

const input = JSON.parse(process.env.TELEGRAM_GATEWAY_FIXTURE_INPUT || '{}');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
  connectionTimeoutMillis: 5_000,
});
const runner = { id: 'runner-telegram-a', workspace_id: 'ws-telegram-a' };
const service = new WorkConversationChannelService({ pool });

const actions = {
  next: () => service.nextOutbound(runner, input.body),
  begin: () => service.beginOutbound(runner, input.body),
  ack: () => service.ackOutbound(runner, input.body),
};

Promise.resolve().then(async () => {
  if (!actions[input.action]) throw new Error('fixture action is invalid');
  const result = await actions[input.action]();
  process.stdout.write(`${JSON.stringify({ ...result, pid: process.pid })}\n`);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error?.code || 'fixture_error',
    message: String(error?.message || error),
  })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
