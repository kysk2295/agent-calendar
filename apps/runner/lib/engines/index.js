'use strict';

const fake = require('./fake');
const codex = require('./codex');
const claude = require('./claude');
const grok = require('./grok');
const hermes = require('./hermes');
const knowledge = require('./knowledge');
const { BANNED_FLAGS, assertSafeArgv } = require('./contract');
const { isFakeEngineAllowed } = require('../runtime-policy');

const ADAPTERS = Object.freeze({
  fake,
  codex,
  claude,
  grok,
  hermes,
  knowledge,
});

function getEngineAdapter(name, { env = {} } = {}) {
  const key = String(name || '').toLowerCase();
  if (key === 'fake' && !isFakeEngineAllowed(env)) {
    const error = new Error('fake engine not allowed outside tests');
    error.code = 'FAKE_ENGINE_FORBIDDEN';
    throw error;
  }
  const adapter = ADAPTERS[key];
  if (!adapter) {
    const error = new Error(`unknown engine: ${key}`);
    error.code = 'UNKNOWN_ENGINE';
    throw error;
  }
  return adapter;
}

module.exports = {
  ADAPTERS,
  getEngineAdapter,
  BANNED_FLAGS,
  assertSafeArgv,
};
