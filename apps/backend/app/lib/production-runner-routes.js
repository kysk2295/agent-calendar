'use strict';

/**
 * Production Runner route handlers — user-scoped owner flows + device-auth flows.
 */

const { sendJson } = require('./production-product-routes');

function publicError(error) {
  const code = error && error.code ? String(error.code) : 'runner_error';
  let status = 500;
  if (error && typeof error.statusHint === 'number') status = error.statusHint;
  else if (/REQUIRED|PARAMS|MISMATCH|INVALID_JSON/i.test(code)) status = 400;
  else if (/ROLE_FORBIDDEN|CLAIM_NOT_CONFIRMABLE|FORBIDDEN/i.test(code)) status = 403;
  else if (/STALE_CURSOR/i.test(code)) status = 409;
  else if (
    /EXPIRED|INVALID|REVOKED|REPLAY|NOT_FOUND|UNAUTHORIZED|PENDING|REJECTED|FENCED|SKEW|CREDENTIAL|SIGNATURE|CHALLENGE|CLAIM|SESSION|NONCE|RUNNER_/i.test(code)
  ) {
    status = 401;
  }
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
 * User-scoped runner product routes (session + WorkspaceScope already resolved).
 * @returns {Promise<boolean>} true if handled
 */
async function handleRunnerUserRoute({
  res,
  route,
  params,
  body,
  scope,
  runtime,
  controlPlaneBaseUrl = '',
}) {
  const control = runtime.runnerControl;
  if (!control) {
    sendJson(res, 503, { ok: false, error: 'runner_control_unavailable', message: 'service_unavailable' });
    return true;
  }

  try {
    switch (route.action) {
      case 'runners_list': {
        const runners = await control.listRunners(scope);
        sendJson(res, 200, { ok: true, runners, workspaceId: scope.workspaceId });
        return true;
      }
      case 'runners_release_manifest': {
        const manifest = await control.getReleaseManifest(scope, body || {});
        sendJson(res, 200, manifest);
        return true;
      }
      case 'runners_enrollment_start': {
        const result = await control.startEnrollment(scope, {
          controlPlaneBaseUrl: body.controlPlaneBaseUrl || controlPlaneBaseUrl,
        });
        // Ensure no secret fields beyond human code / qr for Desktop.
        assertNoDeviceSecrets(result);
        sendJson(res, 200, result);
        return true;
      }
      case 'runners_enrollment_get': {
        const result = await control.getEnrollment(scope, params.id);
        assertNoDeviceSecrets(result);
        sendJson(res, 200, result);
        return true;
      }
      case 'runners_enrollment_confirm': {
        const result = await control.confirmEnrollment(scope, params.id);
        assertNoDeviceSecrets(result);
        sendJson(res, 200, result);
        return true;
      }
      case 'runners_enrollment_reject': {
        const result = await control.rejectEnrollment(scope, params.id);
        assertNoDeviceSecrets(result);
        sendJson(res, 200, result);
        return true;
      }
      case 'runners_test': {
        const result = await control.testConnection(scope, params.id);
        assertNoDeviceSecrets(result);
        sendJson(res, 200, result);
        return true;
      }
      case 'runners_revoke': {
        const result = await control.revokeRunner(scope, params.id);
        assertNoDeviceSecrets(result);
        sendJson(res, 200, result);
        return true;
      }
      default:
        return false;
    }
  } catch (error) {
    const pub = publicError(error);
    sendJson(res, pub.status, pub.body);
    return true;
  }
}

/**
 * Device-auth routes — no user session.
 * @returns {Promise<boolean>} true if handled
 */
async function handleRunnerDeviceRoute({
  res,
  route,
  body,
  headers,
  runtime,
}) {
  const control = runtime.runnerControl;
  if (!control) {
    sendJson(res, 503, { ok: false, error: 'runner_control_unavailable', message: 'service_unavailable' });
    return true;
  }

  try {
    switch (route.action) {
      case 'runner_device_enroll': {
        const result = await control.deviceEnroll(body || {});
        // claimToken is intentionally returned only on device channel.
        sendJson(res, 200, result);
        return true;
      }
      case 'runner_device_claim': {
        const result = await control.deviceClaim(body || {}, headers || {});
        sendJson(res, 200, result);
        return true;
      }
      case 'runner_device_connect': {
        const result = await control.deviceConnect(body || {}, headers || {});
        sendJson(res, 200, result);
        return true;
      }
      case 'runner_device_heartbeat': {
        const result = await control.deviceHeartbeat(body || {}, headers || {});
        sendJson(res, 200, result);
        return true;
      }
      case 'runner_device_capabilities': {
        const result = await control.deviceCapabilities(body || {}, headers || {});
        sendJson(res, 200, result);
        return true;
      }
      case 'runner_device_rotate': {
        const result = await control.deviceRotate(body || {}, headers || {});
        sendJson(res, 200, result);
        return true;
      }
      case 'runner_device_disconnect': {
        const result = await control.deviceDisconnect(body || {}, headers || {});
        sendJson(res, 200, result);
        return true;
      }
      default:
        return false;
    }
  } catch (error) {
    const pub = publicError(error);
    sendJson(res, pub.status, pub.body);
    return true;
  }
}

function assertNoDeviceSecrets(payload) {
  const raw = JSON.stringify(payload || {});
  if (
    /"deviceCredential"\s*:/.test(raw)
    || /"claimToken"\s*:/.test(raw)
    || /"challenge_hash"\s*:/.test(raw)
    || /"credential_hash"\s*:/.test(raw)
    || /"sessionToken"\s*:/.test(raw)
  ) {
    const error = new Error('device secrets must not appear in user API responses');
    error.code = 'DEVICE_SECRET_LEAK';
    error.statusHint = 500;
    throw error;
  }
}

module.exports = {
  handleRunnerUserRoute,
  handleRunnerDeviceRoute,
  publicError,
  assertNoDeviceSecrets,
};
