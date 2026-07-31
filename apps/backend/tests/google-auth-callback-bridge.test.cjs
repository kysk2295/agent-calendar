'use strict';

/**
 * Google redirects a browser back to the gateway, but the Desktop app can only receive the
 * authorization code through its own deep link. The bridge is the only hop between them, so
 * it must forward exactly what the app accepts and nothing else.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isGoogleAuthCallbackPath,
  resolveGoogleAuthCallback,
} = require('../app/lib/google-auth-callback-bridge');

function resolve(query) {
  return resolveGoogleAuthCallback(new URLSearchParams(query));
}

test('only the exact callback path is claimed', () => {
  assert.equal(isGoogleAuthCallbackPath('/api/auth/google/callback'), true);
  assert.equal(isGoogleAuthCallbackPath('/api/auth/google/callback/'), false);
  assert.equal(isGoogleAuthCallbackPath('/api/auth/google/callbackx'), false);
  assert.equal(isGoogleAuthCallbackPath('/api/auth/google'), false);
  assert.equal(isGoogleAuthCallbackPath('/api/calendar/sources/google/callback'), false);
});

test('a valid Google redirect becomes the Desktop deep link the app parses', () => {
  const result = resolve('code=abc-123&state=xyz_456');
  assert.equal(result.ok, true);
  assert.equal(result.location, 'agent-calendar://auth/callback?code=abc-123&state=xyz_456');
});

test('the destination scheme is fixed and can never come from the request', () => {
  // A caller controlling the redirect target would turn the gateway into an open redirect.
  const result = resolve('code=abc&state=xyz&redirect_uri=https://evil.example/steal');
  assert.equal(result.ok, true);
  assert.ok(result.location.startsWith('agent-calendar://auth/callback?'));
  assert.doesNotMatch(result.location, /evil\.example/);
  // The Desktop parser rejects anything other than exactly code and state.
  assert.equal(new URL(result.location).searchParams.size, 2);
});

test('values the Desktop deep link parser would reject are refused here first', () => {
  for (const query of [
    'code=abc',
    'state=xyz',
    '',
    'code=&state=xyz',
    'code=abc&state=',
    'code=has space&state=xyz',
    'code=abc&state=has%2Fslash',
    `code=${'a'.repeat(513)}&state=xyz`,
  ]) {
    const result = resolve(query);
    assert.equal(result.ok, false, `must refuse: ${query || '(empty)'}`);
    assert.equal(result.status, 400);
  }
});

test('a denied consent is reported, never redirected', () => {
  const result = resolve('error=access_denied&state=xyz');
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'access_denied');
  assert.equal(result.location, undefined);
});

test('duplicate parameters are refused rather than silently collapsed', () => {
  const result = resolve('code=good&code=evil&state=xyz');
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});
