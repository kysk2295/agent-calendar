'use strict';

/**
 * Phase 3 device execution routes — Runner-authenticated only.
 * Exact pathname dispatch for device signature verification.
 */

const { sendJson } = require('./production-product-routes');

function publicError(error) {
  const code = error && error.code ? String(error.code) : 'execution_error';
  let status = 500;
  if (error && typeof error.statusHint === 'number') status = error.statusHint;
  else if (/REQUIRED|PARAMS|FORBIDDEN_SECRET|INVALID/i.test(code)) status = 400;
  else if (/FOREIGN|ROLE|CLAIMS_DISABLED/i.test(code)) status = 403;
  else if (/NOT_FOUND/i.test(code)) status = 404;
  else if (/EXPIRED|MISMATCH|NOT_OPEN|NOT_LIVE|FENCED|CANCELLED|MAX_ATTEMPTS|INELIGIBLE|TERMINAL|IDEMPOTENCY|CANCEL_NOT/i.test(code)) status = 409;
  else if (/UNAUTHORIZED|REVOKED|PENDING|CREDENTIAL|SIGNATURE|NONCE|CLOCK/i.test(code)) status = 401;
  return {
    status,
    body: {
      ok: false,
      error: code,
      message: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 400 ? 'bad_request' : status === 409 ? 'conflict' : 'request_failed',
    },
  };
}

/**
 * Authenticate using exact path the client signed, then dispatch device execution action.
 * @returns {Promise<boolean>}
 */
async function handleExecutionDeviceRouteWithPath({
  res,
  route,
  body,
  headers,
  runtime,
  pathname,
}) {
  const control = runtime.runnerControl;
  const execution = runtime.durableExecution;
  if (!control || !execution) {
    sendJson(res, 503, { ok: false, error: 'execution_unavailable', message: 'service_unavailable' });
    return true;
  }

  try {
    const auth = await control.authenticateDeviceRequest({
      method: 'POST',
      path: pathname,
      body: body || {},
      headers: headers || {},
      requireActive: true,
    });
    const runner = auth.runner;

    switch (route.action) {
      case 'runner_device_next_offer':
        sendJson(res, 200, await execution.nextOffer(runner));
        return true;
      case 'runner_device_lease':
        sendJson(res, 200, await execution.leaseOffer(runner, body || {}));
        return true;
      case 'runner_device_event':
        sendJson(res, 200, await execution.postEvent(runner, body || {}));
        return true;
      case 'runner_device_provider_session_bind':
        sendJson(res, 200, await execution.bindProviderSession(runner, body || {}));
        return true;
      case 'runner_device_artifact':
        sendJson(res, 200, await execution.postArtifact(runner, body || {}));
        return true;
      case 'runner_device_complete':
        sendJson(res, 200, await execution.completeAttempt(runner, body || {}));
        return true;
      case 'runner_device_fail':
        sendJson(res, 200, await execution.failAttempt(runner, body || {}));
        return true;
      case 'runner_device_cancel_ack':
        sendJson(res, 200, await execution.ackCancel(runner, body || {}));
        return true;
      case 'runner_device_attempt_heartbeat':
        sendJson(res, 200, await execution.heartbeatAttempt(runner, body || {}));
        return true;
      case 'runner_device_connector_next':
        sendJson(res, 200, await runtime.providerAgentBridge.nextConnectorRequest(runner));
        return true;
      case 'runner_device_connector_complete':
        sendJson(res, 200, await runtime.providerAgentBridge.completeConnectorRequest(runner, body || {}));
        return true;
      case 'runner_device_connector_fail':
        sendJson(res, 200, await runtime.providerAgentBridge.failConnectorRequest(runner, body || {}));
        return true;
      case 'runner_device_telegram_bind':
        sendJson(res, 200, await runtime.workConversationChannels.bind(runner, body || {}));
        return true;
      case 'runner_device_telegram_status':
        sendJson(res, 200, await runtime.workConversationChannels.reportIngressOwnership(runner, body || {}));
        return true;
      case 'runner_device_telegram_inbound':
        sendJson(res, 200, await runtime.workConversationChannels.inbound(runner, body || {}));
        return true;
      case 'runner_device_telegram_next':
        sendJson(res, 200, await runtime.workConversationChannels.nextOutbound(runner, body || {}));
        return true;
      case 'runner_device_telegram_ack':
        sendJson(res, 200, await runtime.workConversationChannels.ackOutbound(runner, body || {}));
        return true;
      default:
        return false;
    }
  } catch (error) {
    const pub = publicError(error);
    sendJson(res, pub.status, pub.body);
    return true;
  }
}

module.exports = {
  handleExecutionDeviceRouteWithPath,
  publicError,
};
