function normalizeRuntimeUrl(runtimeUrl) {
  const clean = String(runtimeUrl || '').trim().replace(/\/+$/, '');
  if (!clean) throw new Error('HERMES_RUNTIME_URL is required');
  return clean;
}

function redactPublicText(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(HERMES_RUNTIME_TOKEN|accessToken|runtimeToken|apiKey|api_key|clientSecret|accessKey|access_key|credential|token)\s*[:=]\s*([^&\s,"'}]+)/gi, '$1=[REDACTED]')
    .replace(/\bauthorization\s*[:=]\s*[^,\n\r]+/gi, 'authorization=[REDACTED]')
    .replace(/"authorization"\s*:\s*"[^"]*"/gi, '"authorization":"[REDACTED]"')
    .replace(/"(HERMES_RUNTIME_TOKEN|accessToken|runtimeToken|apiKey|api_key|clientSecret|accessKey|access_key|credential|token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/"runtimeToken"\s*:\s*"[^"]*"/gi, '"runtimeToken":"[REDACTED]"')
    .replace(/hermes_[A-Za-z0-9._-]+/gi, 'hermes_[REDACTED]')
    .replace(/[A-Za-z0-9._-]*secret[A-Za-z0-9._-]*/gi, '[REDACTED]')
    .replace(/(?:file:\/\/)?\/(?:Users|home|Volumes|private|var\/folders|tmp)\/[^\s"'}]+/g, '[PRIVATE_PATH]')
    .replace(/\bmarket[\s_-]*flow\b/gi, '[REDACTED_PROFILE]');
}

function safePublicText(value, fallback = '', maximumLength = 6_000) {
  const text = redactPublicText(value).trim();
  if (!text) return fallback;
  if (/\[(?:REDACTED|PRIVATE_PATH|REDACTED_PROFILE)\]/i.test(text)) return fallback;
  if (/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|hf_[A-Za-z0-9]{16,}|(?:gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/i.test(text)) return fallback;
  if (/\b[a-f0-9]{48,}\b/i.test(text)) return fallback;
  if (/^\s*(?:sudo\s+)?(?:bash|sh|zsh|fish|curl|wget|rm|mv|cp|chmod|chown|git|npm|npx|pnpm|yarn|node|python\d*|ruby|hermes|launchctl|tar)(?=\s|$)/i.test(text)) return fallback;
  if (/\b(?:command|commandTemplate|rawCommand|recoveryCommand|residentInstallCommand)\s*[:=]/i.test(text)) return fallback;
  return text.slice(0, Math.max(1, Number(maximumLength) || 6_000));
}

function safeRuntimeError(message, fallback) {
  const redacted = redactPublicText(message);
  if (!redacted) return fallback;
  if (/\[(?:REDACTED|PRIVATE_PATH)\]|token|authorization|secret/i.test(redacted)) return fallback;
  return redacted.length > 160 ? fallback : redacted;
}

function normalizePublicRuntimeUrl(runtimeUrl) {
  const clean = String(runtimeUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return clean;
  }
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function buildRuntimePath(path = []) {
  const segments = Array.isArray(path) ? path : [path];
  const clean = segments
    .flatMap((segment) => String(segment || '').split('/'))
    .filter(Boolean)
    .map((segment) => encodeURIComponent(decodePathSegment(segment)));
  return `/api/${clean.join('/')}`;
}

function buildQueryString(query = {}) {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || key === 'path') return;
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)));
      return;
    }
    params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : '';
}

function buildRuntimeProxyRequest({
  runtimeUrl,
  runtimeToken,
  method = 'GET',
  path = [],
  query = {},
  headers = {},
  body,
} = {}) {
  const baseUrl = normalizeRuntimeUrl(runtimeUrl);
  const token = String(runtimeToken || '').trim();
  if (!token) throw new Error('Runtime authentication is not configured');
  const outgoingHeaders = {};
  if (headers['content-type']) outgoingHeaders['content-type'] = headers['content-type'];
  if (headers.accept) outgoingHeaders.accept = headers.accept;
  outgoingHeaders.authorization = `Bearer ${token}`;
  return {
    url: `${baseUrl}${buildRuntimePath(path)}${buildQueryString(query)}`,
    options: {
      method,
      headers: outgoingHeaders,
      ...(body === undefined || method === 'GET' || method === 'HEAD' ? {} : { body }),
    },
  };
}

function redactGatewayConfig({
  runtimeUrl,
  runtimeToken,
  buildCommit = '',
  deploymentId = '',
} = {}) {
  const runtimeConfigured = Boolean(String(runtimeUrl || '').trim());
  const runtimeTokenConfigured = Boolean(String(runtimeToken || '').trim());
  return {
    ready: runtimeConfigured && runtimeTokenConfigured,
    runtimeConfigured,
    runtimeTokenConfigured,
    runtimeUrl: normalizePublicRuntimeUrl(runtimeUrl),
    buildCommit: String(buildCommit || '').slice(0, 12),
    deploymentId: String(deploymentId || ''),
  };
}

function sanitizeRuntimeIdentity(runtime = {}) {
  return {
    machineName: String(runtime.machineName || ''),
    hostname: String(runtime.hostname || ''),
    cwd: String(runtime.cwd || ''),
  };
}

function sanitizeRuntimeUpdate(receipt = {}) {
  return {
    status: String(receipt.status || 'unknown'),
    appliedAt: String(receipt.appliedAt || receipt.finishedAt || ''),
    error: receipt.error ? safeRuntimeError(receipt.error, 'Runtime update receipt has an error') : '',
  };
}

function sanitizeRuntimeVersion(version = {}) {
  return {
    name: String(version.name || ''),
    version: String(version.version || ''),
    capabilities: Array.isArray(version.capabilities) ? version.capabilities.map(String) : [],
  };
}

async function fetchRuntimeHealthWithTimeout({
  request,
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      if (controller) controller.abort();
      const error = new Error('Runtime health request timed out');
      error.name = 'TimeoutError';
      reject(error);
    }, Math.max(1, Number(timeoutMs) || 3000));
    if (timeout && typeof timeout.unref === 'function') timeout.unref();
  });
  const operation = (async () => {
    const response = await fetchImpl(request.url, {
      ...request.options,
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await response.text();
    return { response, text };
  })();
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function buildGatewayStatus({
  runtimeUrl,
  runtimeToken,
  buildCommit = '',
  deploymentId = '',
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  const status = {
    ...redactGatewayConfig({
      runtimeUrl,
      runtimeToken,
      buildCommit,
      deploymentId,
    }),
    runtimeReachable: false,
    runtimeStatus: 0,
    runtime: sanitizeRuntimeIdentity(),
    runtimeUpdate: sanitizeRuntimeUpdate(),
    runtimeVersion: sanitizeRuntimeVersion(),
  };
  if (!status.runtimeConfigured || !status.runtimeTokenConfigured) {
    return status;
  }
  try {
    const request = buildRuntimeProxyRequest({
      runtimeUrl,
      runtimeToken,
      method: 'GET',
      path: ['health'],
    });
    const { response, text } = await fetchRuntimeHealthWithTimeout({
      request,
      fetchImpl,
      timeoutMs,
    });
    status.runtimeStatus = response.status;
    status.runtimeReachable = response.ok;
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      status.runtimeError = 'Invalid runtime health response';
      return status;
    }
    if (response.ok) {
      status.runtime = sanitizeRuntimeIdentity(body.runtime || {});
      status.runtimeUpdate = sanitizeRuntimeUpdate(body.lastRuntimeUpdate || body.runtimeUpdate || {});
      status.runtimeVersion = sanitizeRuntimeVersion(body.runtimeVersion || {});
    } else {
      status.runtimeError = 'Runtime health returned non-OK status';
    }
  } catch (error) {
    status.runtimeReachable = false;
    status.runtimeError = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'Runtime health request timed out'
      : safeRuntimeError(error.message || String(error), 'Runtime health request failed');
  }
  return status;
}

module.exports = {
  buildGatewayStatus,
  buildRuntimeProxyRequest,
  redactPublicText,
  redactGatewayConfig,
  safePublicText,
  safeRuntimeError,
};
