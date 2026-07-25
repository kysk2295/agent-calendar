'use strict';

const { createProviderConnector } = require('./provider-connectors');
const { redactPrivatePaths } = require('./engines/contract');

function publicErrorMessage(error) {
  return redactPrivatePaths(String(error?.message || 'Connector request failed'))
    .replace(/(?:sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+)/gi, '[redacted]')
    .slice(0, 300);
}

async function runConnectorOnce(client, {
  connector = createProviderConnector(),
} = {}) {
  const next = await client.deviceRequest('POST', '/api/runner/device/connectors/next', {});
  if (!next.request) return { ok: true, idle: true };
  const request = next.request;
  try {
    if (!['agent_catalog', 'session_catalog'].includes(request.kind)) {
      const error = new Error('Unsupported connector request');
      error.code = 'CONNECTOR_KIND_UNSUPPORTED';
      throw error;
    }
    const entries = request.kind === 'agent_catalog'
      ? await connector.listAgents(request.provider, {
        consent: request.consent === true,
      })
      : await connector.listSessions(request.provider, {
        consent: request.consent === true,
      });
    await client.deviceRequest('POST', '/api/runner/device/connectors/complete', {
      requestId: request.id,
      entries,
    });
    return { ok: true, completed: true, requestId: request.id, entries: entries.length };
  } catch (error) {
    await client.deviceRequest('POST', '/api/runner/device/connectors/fail', {
      requestId: request.id,
      errorCode: String(error?.code || 'connector_failed').slice(0, 64),
      errorMessage: publicErrorMessage(error),
    });
    return { ok: false, failed: true, requestId: request.id, error: error?.code || 'connector_failed' };
  }
}

module.exports = {
  runConnectorOnce,
};
