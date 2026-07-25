'use strict';

const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
  maxInFlight: 200,
  requestsPerWindow: 600,
  remoteRequestsPerWindow: 1_200,
  maxTrackedFingerprints: 50_000,
  windowMs: 60_000,
  jsonBodyMaxBytes: 1024 * 1024,
  multipartBodyMaxBytes: 25 * 1024 * 1024,
  bodyTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  headersTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function productionRequestSafetyConfig(env = process.env) {
  return {
    maxInFlight: boundedInteger(
      env.AGENT_CALENDAR_REQUEST_MAX_IN_FLIGHT,
      DEFAULTS.maxInFlight,
      1,
      10_000,
    ),
    requestsPerWindow: boundedInteger(
      env.AGENT_CALENDAR_REQUESTS_PER_WINDOW,
      DEFAULTS.requestsPerWindow,
      1,
      100_000,
    ),
    remoteRequestsPerWindow: boundedInteger(
      env.AGENT_CALENDAR_REMOTE_REQUESTS_PER_WINDOW,
      DEFAULTS.remoteRequestsPerWindow,
      1,
      200_000,
    ),
    maxTrackedFingerprints: boundedInteger(
      env.AGENT_CALENDAR_MAX_TRACKED_FINGERPRINTS,
      DEFAULTS.maxTrackedFingerprints,
      1_000,
      500_000,
    ),
    windowMs: boundedInteger(
      env.AGENT_CALENDAR_REQUEST_WINDOW_MS,
      DEFAULTS.windowMs,
      1_000,
      60 * 60_000,
    ),
    jsonBodyMaxBytes: boundedInteger(
      env.AGENT_CALENDAR_JSON_BODY_MAX_BYTES,
      DEFAULTS.jsonBodyMaxBytes,
      1024,
      20 * 1024 * 1024,
    ),
    multipartBodyMaxBytes: boundedInteger(
      env.AGENT_CALENDAR_MULTIPART_BODY_MAX_BYTES,
      DEFAULTS.multipartBodyMaxBytes,
      1024,
      100 * 1024 * 1024,
    ),
    bodyTimeoutMs: boundedInteger(
      env.AGENT_CALENDAR_BODY_TIMEOUT_MS,
      DEFAULTS.bodyTimeoutMs,
      100,
      120_000,
    ),
    requestTimeoutMs: boundedInteger(
      env.AGENT_CALENDAR_REQUEST_TIMEOUT_MS,
      DEFAULTS.requestTimeoutMs,
      1_000,
      10 * 60_000,
    ),
    headersTimeoutMs: boundedInteger(
      env.AGENT_CALENDAR_HEADERS_TIMEOUT_MS,
      DEFAULTS.headersTimeoutMs,
      1_000,
      120_000,
    ),
    keepAliveTimeoutMs: boundedInteger(
      env.AGENT_CALENDAR_KEEP_ALIVE_TIMEOUT_MS,
      DEFAULTS.keepAliveTimeoutMs,
      500,
      60_000,
    ),
  };
}

function requestSafetyError(code, statusHint) {
  const error = new Error(code);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function readBoundedRequestBody(req, {
  maxBytes = DEFAULTS.jsonBodyMaxBytes,
  timeoutMs = DEFAULTS.bodyTimeoutMs,
} = {}) {
  const safeMaxBytes = boundedInteger(maxBytes, DEFAULTS.jsonBodyMaxBytes, 1, 100 * 1024 * 1024);
  const safeTimeoutMs = boundedInteger(timeoutMs, DEFAULTS.bodyTimeoutMs, 1, 120_000);
  const declaredLength = Number(req && req.headers && req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > safeMaxBytes) {
    if (typeof req.resume === 'function') req.resume();
    return Promise.reject(requestSafetyError('PAYLOAD_TOO_LARGE', 413));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };
    const finish = (callback, value, { drain = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain && typeof req.resume === 'function') req.resume();
      callback(value);
    };
    const onData = (chunk) => {
      const buffer = Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > safeMaxBytes) {
        finish(reject, requestSafetyError('PAYLOAD_TOO_LARGE', 413), { drain: true });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, receivedBytes));
    const onError = () => finish(reject, requestSafetyError('REQUEST_BODY_FAILED', 400));
    const onAborted = () => finish(reject, requestSafetyError('REQUEST_BODY_ABORTED', 400));
    const timer = setTimeout(() => {
      finish(reject, requestSafetyError('REQUEST_BODY_TIMEOUT', 408), { drain: true });
    }, safeTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function requestBodyLimit(req, env = process.env) {
  const config = productionRequestSafetyConfig(env);
  const contentType = String(req && req.headers && req.headers['content-type'] || '');
  return /multipart\/form-data/i.test(contentType)
    ? config.multipartBodyMaxBytes
    : config.jsonBodyMaxBytes;
}

function readProductionRequestBody(req, env = process.env) {
  const config = productionRequestSafetyConfig(env);
  return readBoundedRequestBody(req, {
    maxBytes: requestBodyLimit(req, env),
    timeoutMs: config.bodyTimeoutMs,
  });
}

function readBearer(headers = {}) {
  const authorization = String(headers.authorization || headers.Authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function remoteAddress(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/^::ffff:/, '');
  return normalized || 'unknown';
}

function createProductionRequestSafety({
  env = process.env,
  now = Date.now,
  fingerprintSecret = crypto.randomBytes(32),
  maxInFlight,
  requestsPerWindow,
  remoteRequestsPerWindow,
  maxTrackedFingerprints,
  windowMs,
} = {}) {
  const configured = productionRequestSafetyConfig(env);
  const capacity = boundedInteger(maxInFlight, configured.maxInFlight, 1, 10_000);
  const requestLimit = boundedInteger(requestsPerWindow, configured.requestsPerWindow, 1, 100_000);
  const remoteRequestLimit = boundedInteger(
    remoteRequestsPerWindow,
    configured.remoteRequestsPerWindow,
    1,
    200_000,
  );
  const fingerprintLimit = boundedInteger(
    maxTrackedFingerprints,
    configured.maxTrackedFingerprints,
    1,
    500_000,
  );
  const requestWindowMs = boundedInteger(windowMs, configured.windowMs, 1_000, 60 * 60_000);
  const callerBuckets = new Map();
  const remoteBuckets = new Map();
  let inFlight = 0;
  let accepted = 0;
  let rejectedRate = 0;
  let rejectedCapacity = 0;

  function fingerprint(authority) {
    return crypto.createHmac('sha256', fingerprintSecret).update(authority, 'utf8').digest('hex');
  }

  function trackedFingerprintCount() {
    return callerBuckets.size + remoteBuckets.size;
  }

  function pruneBuckets(buckets, timestamp) {
    const staleBefore = timestamp - (requestWindowMs * 2);
    for (const [key, bucket] of buckets) {
      if (bucket.lastSeenAt < staleBefore) buckets.delete(key);
    }
  }

  function consumeBucket(buckets, key, limit, timestamp) {
    let bucket = buckets.get(key);
    if (!bucket || timestamp - bucket.startedAt >= requestWindowMs) {
      if (!bucket && trackedFingerprintCount() >= fingerprintLimit) {
        pruneBuckets(remoteBuckets, timestamp);
        pruneBuckets(callerBuckets, timestamp);
        if (trackedFingerprintCount() >= fingerprintLimit) {
          return {
            saturated: true,
            retryAfterSeconds: 1,
          };
        }
      }
      bucket = {
        startedAt: timestamp,
        lastSeenAt: timestamp,
        count: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.lastSeenAt = timestamp;
    if (bucket.count >= limit) {
      return {
        saturated: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + requestWindowMs - timestamp) / 1000)),
      };
    }
    bucket.count += 1;
    return {
      saturated: false,
      retryAfterSeconds: 0,
    };
  }

  function admit({ pathname = '', headers = {}, remoteAddress: address = '' } = {}) {
    if (String(pathname) === '/api/health') {
      return {
        ok: true,
        release() {},
      };
    }

    if (inFlight >= capacity) {
      rejectedCapacity += 1;
      return {
        ok: false,
        status: 503,
        error: 'gateway_over_capacity',
        retryAfterSeconds: 1,
      };
    }

    const timestamp = now();
    if (trackedFingerprintCount() >= Math.min(1024, fingerprintLimit)) {
      pruneBuckets(remoteBuckets, timestamp);
      pruneBuckets(callerBuckets, timestamp);
    }
    const networkAdmission = consumeBucket(
      remoteBuckets,
      fingerprint(`remote:${remoteAddress(address)}`),
      remoteRequestLimit,
      timestamp,
    );
    if (networkAdmission.saturated) {
      rejectedCapacity += 1;
      return {
        ok: false,
        status: 503,
        error: 'gateway_over_capacity',
        retryAfterSeconds: networkAdmission.retryAfterSeconds,
      };
    }
    if (networkAdmission.retryAfterSeconds) {
      rejectedRate += 1;
      return {
        ok: false,
        status: 429,
        error: 'request_rate_limited',
        retryAfterSeconds: networkAdmission.retryAfterSeconds,
      };
    }

    const bearer = readBearer(headers);
    if (bearer) {
      const callerAdmission = consumeBucket(
        callerBuckets,
        fingerprint(`bearer:${bearer}`),
        requestLimit,
        timestamp,
      );
      if (callerAdmission.saturated) {
        rejectedCapacity += 1;
        return {
          ok: false,
          status: 503,
          error: 'gateway_over_capacity',
          retryAfterSeconds: callerAdmission.retryAfterSeconds,
        };
      }
      if (callerAdmission.retryAfterSeconds) {
        rejectedRate += 1;
        return {
          ok: false,
          status: 429,
          error: 'request_rate_limited',
          retryAfterSeconds: callerAdmission.retryAfterSeconds,
        };
      }
    }

    inFlight += 1;
    accepted += 1;
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        inFlight = Math.max(0, inFlight - 1);
      },
    };
  }

  function snapshot() {
    return {
      schemaVersion: 1,
      inFlight,
      accepted,
      rejectedRate,
      rejectedCapacity,
    };
  }

  return {
    admit,
    snapshot,
  };
}

function configureProductionServerTimeouts(server, env = process.env) {
  const config = productionRequestSafetyConfig(env);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.headersTimeoutMs, config.requestTimeoutMs);
  server.keepAliveTimeout = Math.min(config.keepAliveTimeoutMs, server.headersTimeout);
  return server;
}

module.exports = {
  configureProductionServerTimeouts,
  createProductionRequestSafety,
  productionRequestSafetyConfig,
  readBoundedRequestBody,
  readProductionRequestBody,
  requestBodyLimit,
};
