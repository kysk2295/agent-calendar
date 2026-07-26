'use strict';

const VERIFIED_ENGINE_AUTH_STATUSES = Object.freeze([
  'authenticated',
  'ok',
  'ready',
  'active',
]);

function engineAuthStatus(value) {
  if (!value || typeof value !== 'object') return 'unknown';
  return String(value.authStatus || value.auth || 'unknown').trim().toLowerCase() || 'unknown';
}

function engineReportsAvailability(value) {
  return Boolean(value)
    && typeof value === 'object'
    && (value.available === true || String(value.status || '').toLowerCase() === 'available');
}

function engineAuthenticationVerified(value) {
  return VERIFIED_ENGINE_AUTH_STATUSES.includes(engineAuthStatus(value));
}

function engineCapabilityReady(value) {
  return engineReportsAvailability(value) && engineAuthenticationVerified(value);
}

module.exports = {
  VERIFIED_ENGINE_AUTH_STATUSES,
  engineAuthStatus,
  engineReportsAvailability,
  engineAuthenticationVerified,
  engineCapabilityReady,
};
