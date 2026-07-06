function readBearerToken(headers = {}) {
  const header = headers.authorization || headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function readQueryToken(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('access_token') || '';
  } catch {
    return '';
  }
}

function isAuthorizedRequest(req, authSettings = {}) {
  if (!authSettings.accessToken) return true;
  const token = readBearerToken(req.headers || {}) || readQueryToken(req);
  return token === authSettings.accessToken;
}

module.exports = {
  isAuthorizedRequest,
  readBearerToken,
};
