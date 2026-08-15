'use strict';

const os = require('node:os');
const {
  PROTOCOL_VERSION,
  sign,
  bodySha256,
  enrollTranscript,
  claimTranscript,
  deviceTranscript,
  newNonce,
  formatFingerprint,
  fingerprint,
} = require('./crypto');
const {
  loadOrCreateIdentity,
  listKnowledgeSources,
  loadState,
  saveState,
  defaultStateDir,
} = require('./store');
const { probeAllEngines } = require('./capabilities');

const RUNNER_VERSION = require('../package.json').version;

async function httpJson(baseUrl, method, urlPath, { headers = {}, body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 30_000));
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, '')}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: response.status, json, headers: response.headers };
  } catch (error) {
    if (error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || '')))) {
      const err = new Error(`request timeout ${method} ${urlPath}`);
      err.code = 'REQUEST_TIMEOUT';
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function hostMeta() {
  return {
    hostName: os.hostname(),
    hostOs: `${os.platform()} ${os.release()}`,
  };
}

class RunnerClient {
  constructor({
    baseUrl,
    stateDir = defaultStateDir(),
    probeRunner = null,
    clock = () => Date.now(),
    env = {},
  } = {}) {
    if (!baseUrl) throw new Error('RunnerClient requires baseUrl');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.stateDir = stateDir;
    this.probeRunner = probeRunner;
    this.clock = clock;
    this.env = env;
    this.identity = loadOrCreateIdentity(stateDir);
    this.state = loadState(stateDir);
  }

  persist(patch = {}) {
    this.state = { ...this.state, ...patch, updatedAt: new Date(this.clock()).toISOString() };
    saveState(this.stateDir, this.state);
    return this.state;
  }

  async enroll({ challengeId, challengeCode }) {
    const host = hostMeta();
    const body = {
      challengeId: String(challengeId || '').trim(),
      challengeCode: String(challengeCode || '').trim().toUpperCase(),
      devicePublicKey: this.identity.publicKey,
      protocolVersion: PROTOCOL_VERSION,
      hostName: host.hostName,
      hostOs: host.hostOs,
      runnerVersion: RUNNER_VERSION,
    };
    const transcript = enrollTranscript({
      challengeId: body.challengeId,
      challengeCode: body.challengeCode,
      devicePublicKey: body.devicePublicKey,
      protocolVersion: body.protocolVersion,
      hostName: body.hostName,
      hostOs: body.hostOs,
      runnerVersion: body.runnerVersion,
    });
    body.signature = sign(this.identity.privateKey, transcript);

    const res = await httpJson(this.baseUrl, 'POST', '/api/runner/device/enroll', { body });
    if (res.status >= 400 || !res.json?.ok) {
      const err = new Error(res.json?.error || 'enroll_failed');
      err.code = res.json?.error || 'enroll_failed';
      err.status = res.status;
      throw err;
    }
    this.persist({
      runnerId: res.json.runnerId,
      claimToken: res.json.claimToken,
      claimExpiresAt: res.json.claimExpiresAt,
      workspaceId: res.json.workspaceId,
      status: 'pending',
      fingerprint: res.json.fingerprint || formatFingerprint(fingerprint(this.identity.publicKey)),
    });
    return res.json;
  }

  async claim() {
    const runnerId = this.state.runnerId;
    const claimToken = this.state.claimToken;
    if (!runnerId || !claimToken) throw Object.assign(new Error('missing claim state'), { code: 'CLAIM_STATE_MISSING' });

    const timestampMs = this.clock();
    const nonce = newNonce();
    const body = {
      runnerId,
      claimToken,
      timestampMs,
      nonce,
    };
    body.signature = sign(this.identity.privateKey, claimTranscript({
      runnerId,
      claimToken,
      timestampMs,
      nonce,
    }));

    const res = await httpJson(this.baseUrl, 'POST', '/api/runner/device/claim', { body });
    if (res.status >= 400 || !res.json?.ok) {
      const err = new Error(res.json?.error || 'claim_failed');
      err.code = res.json?.error || 'claim_failed';
      err.status = res.status;
      throw err;
    }
    this.persist({
      deviceCredential: res.json.deviceCredential,
      credentialVersion: res.json.credentialVersion,
      status: 'active',
      claimToken: undefined,
    });
    // Strip claim token from disk after claim.
    const next = { ...this.state };
    delete next.claimToken;
    this.state = next;
    saveState(this.stateDir, this.state);
    return res.json;
  }

  async deviceRequest(method, urlPath, body = {}) {
    const runnerId = this.state.runnerId;
    const credential = this.state.deviceCredential;
    if (!runnerId || !credential) {
      throw Object.assign(new Error('device not claimed'), { code: 'DEVICE_NOT_CLAIMED' });
    }
    const timestampMs = this.clock();
    const nonce = newNonce();
    const sessionId = this.state.sessionId || '';
    const cursor = this.state.cursor != null ? this.state.cursor : '';
    const payload = { ...body, runnerId };
    const bodyHash = bodySha256(payload);
    const transcript = deviceTranscript({
      method,
      path: urlPath,
      bodyHash,
      timestampMs,
      nonce,
      runnerId,
      sessionId,
      cursor,
    });
    const signature = sign(this.identity.privateKey, transcript);
    const headers = {
      'x-runner-id': runnerId,
      'x-runner-timestamp': String(timestampMs),
      'x-runner-nonce': nonce,
      'x-runner-session': sessionId,
      'x-runner-cursor': cursor === '' ? '' : String(cursor),
      'x-runner-credential': credential,
      'x-runner-signature': signature,
    };
    const res = await httpJson(this.baseUrl, method, urlPath, { headers, body: payload });
    if (res.status >= 400 || !res.json?.ok) {
      const err = new Error(res.json?.error || 'device_request_failed');
      err.code = res.json?.error || 'device_request_failed';
      err.status = res.status;
      throw err;
    }
    return res.json;
  }

  async connect() {
    // Reconnect must not bind the signature to a fenced prior session.
    this.state = {
      ...this.state,
      sessionId: '',
      sessionToken: undefined,
      cursor: '',
    };
    saveState(this.stateDir, this.state);
    const result = await this.deviceRequest('POST', '/api/runner/device/connect', {
      protocolVersion: PROTOCOL_VERSION,
    });
    this.persist({
      sessionId: result.sessionId,
      sessionToken: result.sessionToken,
      cursor: result.cursor,
      connectionState: result.connectionState || 'connected',
    });
    return result;
  }

  async heartbeat() {
    const result = await this.deviceRequest('POST', '/api/runner/device/heartbeat', {
      sessionId: this.state.sessionId,
      cursor: this.state.cursor,
    });
    this.persist({
      cursor: result.cursor,
      connectionState: result.connectionState || 'connected',
    });
    return result;
  }

  async reportCapabilities() {
    const report = await probeAllEngines({
      probeRunner: this.probeRunner || undefined,
      env: this.env,
    });
    const localKnowledge = listKnowledgeSources(this.stateDir).length > 0;
    const result = await this.deviceRequest('POST', '/api/runner/device/capabilities', {
      engines: report.engines,
      catalog: report.catalog,
      maxConcurrentWork: report.maxConcurrentWork,
      localKnowledge,
      knowledgeSearch: localKnowledge,
    });
    this.persist({
      capabilities: {
        ...(result.capabilities && typeof result.capabilities === 'object'
          ? result.capabilities
          : {}),
        maxConcurrentWork: report.maxConcurrentWork,
      },
    });
    return result;
  }

  async rotate() {
    const result = await this.deviceRequest('POST', '/api/runner/device/rotate', {});
    this.persist({
      deviceCredential: result.deviceCredential,
      credentialVersion: result.credentialVersion,
      sessionId: undefined,
      sessionToken: undefined,
      connectionState: 'reconnecting',
    });
    const next = { ...this.state };
    delete next.sessionId;
    delete next.sessionToken;
    this.state = next;
    saveState(this.stateDir, this.state);
    return result;
  }

  async disconnect() {
    const result = await this.deviceRequest('POST', '/api/runner/device/disconnect', {
      sessionId: this.state.sessionId,
    });
    this.persist({ connectionState: 'disconnected', sessionId: undefined });
    return result;
  }

  /**
   * Full enrollment journey for a challenge: enroll → poll claim until confirmable succeeds.
   */
  async enrollAndClaim({ challengeId, challengeCode, pollMs = 500, timeoutMs = 30_000 }) {
    await this.enroll({ challengeId, challengeCode });
    const deadline = this.clock() + timeoutMs;
    let lastError = null;
    while (this.clock() < deadline) {
      try {
        return await this.claim();
      } catch (error) {
        lastError = error;
        if (error && error.code === 'CLAIM_NOT_CONFIRMABLE') {
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        throw error;
      }
    }
    throw lastError || Object.assign(new Error('claim timeout'), { code: 'CLAIM_TIMEOUT' });
  }
}

module.exports = {
  RunnerClient,
  RUNNER_VERSION,
  PROTOCOL_VERSION,
  httpJson,
};
