'use strict';

const crypto = require('node:crypto');
const { createProviderConnector } = require('./provider-connectors');
const { redactPrivatePaths } = require('./engines/contract');

const KNOWN_NO_SIDE_EFFECT_ERRORS = new Set([
  'CONNECTOR_AUTOMATION_ACTION_UNSUPPORTED',
  'CONNECTOR_AUTOMATION_AUTH_REQUIRED',
  'CONNECTOR_AUTOMATION_NOT_CONFIGURED',
  'CONNECTOR_AUTOMATION_UNSUPPORTED',
  'CONNECTOR_AUTOMATION_URL_INVALID',
  'CONNECTOR_CONSENT_REQUIRED',
  'CONNECTOR_KIND_UNSUPPORTED',
  'CONNECTOR_OUTPUT_INVALID',
  'CONNECTOR_OUTPUT_SECRET',
  'SOURCE_REVISION_CONFLICT',
]);

function publicErrorMessage(error) {
  return redactPrivatePaths(String(error?.message || 'Connector request failed'))
    .replace(/(?:sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+)/gi, '[redacted]')
    .slice(0, 300);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function connectorRequestHash(request = {}) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue({
      id: request.id,
      provider: request.provider,
      kind: request.kind,
      payload: request.payload,
    })))
    .digest('hex');
}

function persistConnectorMutation(client, value) {
  if (typeof client.persist !== 'function') {
    const error = new Error('Runner connector mutation journal is unavailable');
    error.code = 'CONNECTOR_JOURNAL_UNAVAILABLE';
    throw error;
  }
  client.persist({ activeConnectorMutation: value });
}

async function failMutationUnknown(client, request) {
  await client.deviceRequest('POST', '/api/runner/device/connectors/fail', {
    requestId: request.id,
    errorCode: 'SOURCE_OUTCOME_UNKNOWN',
    errorMessage: 'Hermes automation outcome is unknown; source synchronization is required',
  });
  persistConnectorMutation(client, null);
  return {
    ok: false,
    failed: true,
    requestId: request.id,
    error: 'SOURCE_OUTCOME_UNKNOWN',
  };
}

async function runAutomationMutation(client, connector, request) {
  const requestHash = connectorRequestHash(request);
  const journal = client.state?.activeConnectorMutation;
  let result;
  if (journal) {
    if (journal.requestId !== request.id) {
      const error = new Error('Another automation mutation requires recovery');
      error.code = 'CONNECTOR_MUTATION_RECOVERY_REQUIRED';
      throw error;
    }
    if (journal.requestHash !== requestHash) {
      const error = new Error('Automation mutation replay does not match its journal');
      error.code = 'CONNECTOR_REPLAY_MISMATCH';
      throw error;
    }
    if (journal.status === 'started') {
      return failMutationUnknown(client, request);
    }
    if (journal.status !== 'completed' || !journal.result || typeof journal.result !== 'object') {
      const error = new Error('Automation mutation journal is invalid');
      error.code = 'CONNECTOR_JOURNAL_INVALID';
      throw error;
    }
    result = journal.result;
  } else {
    persistConnectorMutation(client, {
      requestId: request.id,
      requestHash,
      status: 'started',
    });
    try {
      result = await connector.runAutomation(request.provider, {
        kind: request.kind,
        consent: request.consent === true,
        ...(request.payload && typeof request.payload === 'object' ? request.payload : {}),
      });
    } catch (error) {
      if (KNOWN_NO_SIDE_EFFECT_ERRORS.has(error?.code)) {
        persistConnectorMutation(client, null);
        throw error;
      }
      return failMutationUnknown(client, request);
    }
    persistConnectorMutation(client, {
      requestId: request.id,
      requestHash,
      status: 'completed',
      result,
    });
  }
  try {
    await client.deviceRequest('POST', '/api/runner/device/connectors/complete', {
      requestId: request.id,
      result,
    });
  } catch {
    return {
      ok: false,
      deferred: true,
      requestId: request.id,
      error: 'CONNECTOR_COMPLETION_DEFERRED',
    };
  }
  persistConnectorMutation(client, null);
  return { ok: true, completed: true, requestId: request.id };
}

async function runConnectorOnce(client, {
  connector = createProviderConnector(),
} = {}) {
  const next = await client.deviceRequest('POST', '/api/runner/device/connectors/next', {});
  if (!next.request) return { ok: true, idle: true };
  const request = next.request;
  try {
    const automationRequest = [
      'automation_capabilities',
      'automation_list',
      'automation_mutation',
    ].includes(request.kind);
    if (!['agent_catalog', 'session_catalog'].includes(request.kind) && !automationRequest) {
      const error = new Error('Unsupported connector request');
      error.code = 'CONNECTOR_KIND_UNSUPPORTED';
      throw error;
    }
    if (automationRequest) {
      if (request.kind === 'automation_mutation') {
        return runAutomationMutation(client, connector, request);
      }
      const result = await connector.runAutomation(request.provider, {
        kind: request.kind,
        consent: request.consent === true,
        ...(request.payload && typeof request.payload === 'object' ? request.payload : {}),
      });
      await client.deviceRequest('POST', '/api/runner/device/connectors/complete', {
        requestId: request.id,
        result,
      });
      return { ok: true, completed: true, requestId: request.id };
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
  connectorRequestHash,
  runConnectorOnce,
};
