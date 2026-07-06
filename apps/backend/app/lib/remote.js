const crypto = require('node:crypto');
const dns = require('node:dns');
const https = require('node:https');

function normalizePublicBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function buildRemoteEndpoints({ publicBaseUrl } = {}) {
  const base = normalizePublicBaseUrl(publicBaseUrl);
  return {
    appUrl: base ? `${base}/` : '',
    telegramWebhookUrl: base ? `${base}/api/telegram/webhook` : '',
    ticktickRedirectUrl: base ? `${base}/ticktick/callback` : '',
  };
}

function checkRemoteReadiness({ remote = {}, auth = {} } = {}) {
  const publicBaseUrl = normalizePublicBaseUrl(remote.publicBaseUrl);
  const endpoints = buildRemoteEndpoints({ publicBaseUrl });
  const checks = {
    publicBaseUrl: {
      ready: Boolean(publicBaseUrl),
      value: publicBaseUrl,
    },
    authToken: {
      ready: Boolean(auth.accessToken),
      value: auth.accessToken ? 'configured' : '',
    },
  };
  return {
    ready: Object.values(checks).every((check) => check.ready),
    checks,
    endpoints,
  };
}

function formatProbeError(error) {
  const message = error.message || String(error);
  const cause = error.cause && (error.cause.message || String(error.cause));
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

function isDnsResolutionError(errorText) {
  return /ENOTFOUND|getaddrinfo/i.test(errorText || '');
}

async function readResponsePayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function createPublicDnsResolve4(servers = ['1.1.1.1', '8.8.8.8']) {
  return async (hostname) => {
    const resolver = new dns.promises.Resolver();
    resolver.setServers(servers);
    return resolver.resolve4(hostname);
  };
}

function createResolvedAddressLookup(address) {
  return (_hostname, options, callback) => {
    let resolvedOptions = options;
    let resolvedCallback = callback;
    if (typeof resolvedOptions === 'function') {
      resolvedCallback = resolvedOptions;
      resolvedOptions = {};
    }
    if (resolvedOptions && resolvedOptions.all) {
      resolvedCallback(null, [{ address, family: 4 }]);
      return;
    }
    resolvedCallback(null, address, 4);
  };
}

function fetchWithResolvedAddress(url, address, { headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
      servername: target.hostname,
      timeout: Number(timeoutMs) || 5000,
      lookup: createResolvedAddressLookup(address),
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          json: async () => {
            try {
              return JSON.parse(body || '{}');
            } catch {
              return {};
            }
          },
        });
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('Public DNS fallback probe timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function verifyPublicAccess({
  publicBaseUrl,
  accessToken = '',
  fetchImpl = fetch,
  publicDnsResolve4 = createPublicDnsResolve4(),
  resolvedFetchImpl = fetchWithResolvedAddress,
  timeoutMs = 5000,
} = {}) {
  const base = normalizePublicBaseUrl(publicBaseUrl);
  if (!base) {
    return {
      reachable: false,
      status: 0,
      url: '',
      name: '',
      error: 'No public base URL configured',
    };
  }

  const url = `${base}/api/health`;
  const headers = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 5000);
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: controller.signal,
    });
    const payload = await readResponsePayload(response);
    return {
      reachable: Boolean(response.ok && payload.ok),
      status: response.status || 0,
      url,
      name: payload.name || '',
      error: response.ok ? '' : `HTTP ${response.status}`,
      resolver: 'default',
    };
  } catch (error) {
    const errorText = error.name === 'AbortError' ? 'Public access probe timed out' : formatProbeError(error);
    if (error.name !== 'AbortError' && isDnsResolutionError(errorText)) {
      try {
        const hostname = new URL(url).hostname;
        const addresses = await publicDnsResolve4(hostname);
        const publicDnsAddress = addresses[0] || '';
        if (!publicDnsAddress) throw new Error('Public DNS returned no A records');
        const response = await resolvedFetchImpl(url, publicDnsAddress, { headers, timeoutMs });
        const payload = await readResponsePayload(response);
        return {
          reachable: Boolean(response.ok && payload.ok),
          status: response.status || 0,
          url,
          name: payload.name || '',
          error: response.ok ? '' : `HTTP ${response.status}`,
          resolver: 'public-dns-fallback',
          diagnostics: {
            localResolverError: errorText,
            publicDnsAddress,
          },
        };
      } catch (fallbackError) {
        return {
          reachable: false,
          status: 0,
          url,
          name: '',
          error: `${errorText}; public DNS fallback failed: ${formatProbeError(fallbackError)}`,
          resolver: 'public-dns-fallback',
        };
      }
    }
    return {
      reachable: false,
      status: 0,
      url,
      name: '',
      error: errorText,
      resolver: 'default',
    };
  } finally {
    clearTimeout(timer);
  }
}

function generateAccessToken({ prefix = 'hermes_', bytes = 24, randomBytes = crypto.randomBytes } = {}) {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

module.exports = {
  buildRemoteEndpoints,
  checkRemoteReadiness,
  createResolvedAddressLookup,
  generateAccessToken,
  normalizePublicBaseUrl,
  verifyPublicAccess,
};
