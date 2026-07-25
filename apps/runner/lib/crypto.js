'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;

function generateEd25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

function sign(privateKeyB64, message) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(String(privateKeyB64), 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, Buffer.from(String(message), 'utf8'), key).toString('base64url');
}

function fingerprint(publicKeyB64) {
  return crypto.createHash('sha256').update(String(publicKeyB64 || ''), 'utf8').digest('hex');
}

function formatFingerprint(hex) {
  const clean = String(hex || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  const groups = [];
  for (let i = 0; i < clean.length; i += 4) groups.push(clean.slice(i, i + 4));
  return groups.join(' ');
}

function bodySha256(body) {
  const raw = body == null || body === ''
    ? ''
    : typeof body === 'string'
      ? body
      : JSON.stringify(body);
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function enrollTranscript({
  challengeId,
  challengeCode,
  devicePublicKey,
  protocolVersion,
  hostName,
  hostOs,
  runnerVersion,
}) {
  return [
    'enroll-v1',
    `challengeId=${challengeId}`,
    `challengeCode=${challengeCode}`,
    `devicePublicKey=${devicePublicKey}`,
    `protocolVersion=${protocolVersion}`,
    `hostName=${hostName || ''}`,
    `hostOs=${hostOs || ''}`,
    `runnerVersion=${runnerVersion || ''}`,
  ].join('\n');
}

function claimTranscript({ runnerId, claimToken, timestampMs, nonce }) {
  return [
    'claim-v1',
    `runnerId=${runnerId}`,
    `claimToken=${claimToken}`,
    `timestampMs=${timestampMs}`,
    `nonce=${nonce || ''}`,
  ].join('\n');
}

function deviceTranscript({
  method,
  path,
  bodyHash,
  timestampMs,
  nonce,
  runnerId,
  sessionId,
  cursor,
}) {
  return [
    'device-v1',
    String(method || '').toUpperCase(),
    String(path || ''),
    String(bodyHash || ''),
    String(timestampMs || ''),
    String(nonce || ''),
    String(runnerId || ''),
    String(sessionId || ''),
    String(cursor == null ? '' : cursor),
  ].join('\n');
}

function newNonce() {
  return crypto.randomBytes(16).toString('base64url');
}

module.exports = {
  PROTOCOL_VERSION,
  generateEd25519Keypair,
  sign,
  fingerprint,
  formatFingerprint,
  bodySha256,
  enrollTranscript,
  claimTranscript,
  deviceTranscript,
  newNonce,
};
