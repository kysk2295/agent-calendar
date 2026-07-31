'use strict';

function isFakeEngineAllowed(env) {
  return env !== null
    && typeof env === 'object'
    && env.NODE_ENV === 'test'
    && env.AGENT_CALENDAR_ALLOW_FAKE_ENGINE === '1';
}

module.exports = {
  isFakeEngineAllowed,
};
