import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/api/hermesApi.ts', import.meta.url),
  'utf8',
);
const authSource = readFileSync(
  new URL('../electron/auth.ts', import.meta.url),
  'utf8',
);
const secureSessionSource = readFileSync(
  new URL('../electron/secureSession.ts', import.meta.url),
  'utf8',
);
const mainContractSource = readFileSync(
  new URL('../electron/clientContract.ts', import.meta.url),
  'utf8',
);

test('Desktop JSON and SSE requests identify the frozen client-v1 contract', () => {
  assert.ok(source.includes("export const CLIENT_V1_CONTRACT_ID = 'client-v1';"));
  assert.ok(source.includes(
    "export const CLIENT_V1_MEDIA_TYPE = 'application/vnd.agent-calendar.client-v1+json';",
  ));
  assert.ok(source.includes(
    "export const CLIENT_CONTRACT_HEADER = 'x-agent-calendar-contract';",
  ));
  assert.ok(source.includes(
    'headers.set(CLIENT_CONTRACT_HEADER, CLIENT_V1_CONTRACT_ID)',
  ));
  assert.ok(source.includes(
    "headers.set('accept', `${CLIENT_V1_MEDIA_TYPE}, application/json`)",
  ));
  assert.ok(source.includes("accept: 'text/event-stream'"));
});

test('Desktop product mutations attach one client request identity as the idempotency key', () => {
  assert.ok(source.includes(
    "const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])",
  ));
  assert.ok(source.includes("headers.set('x-client-request-id', requestId)"));
  assert.ok(source.includes("headers.set('idempotency-key', requestId)"));
  assert.ok(source.includes('crypto.randomUUID()'));
});

test('Desktop main-process login, refresh, and logout use the same client-v1 identity contract', () => {
  assert.ok(mainContractSource.includes(
    "export const CLIENT_V1_CONTRACT_ID = 'client-v1';",
  ));
  assert.ok(mainContractSource.includes(
    "export const CLIENT_V1_MEDIA_TYPE = 'application/vnd.agent-calendar.client-v1+json';",
  ));
  assert.ok(mainContractSource.includes(
    "export const CLIENT_CONTRACT_HEADER = 'x-agent-calendar-contract';",
  ));
  assert.ok(authSource.includes("from './clientContract.js'"));
  assert.ok(secureSessionSource.includes("from './clientContract.js'"));
  assert.ok(authSource.includes('headers: clientV1JsonHeaders()'));
  assert.ok(secureSessionSource.includes('headers: clientV1JsonHeaders()'));
  assert.ok(secureSessionSource.includes('headers: clientV1JsonHeaders({'));
});
