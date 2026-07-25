'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { listProductionRoutes } = require('../app/lib/production-route-registry');
const {
  CLIENT_V1_CONTRACT_ID,
  CLIENT_V1_MEDIA_TYPE,
  CLIENT_V1_RESPONSE_HEADER,
  assertClientV1Contract,
  clientV1ContractManifest,
  negotiateClientContract,
  validateClientV1Request,
} = require('../app/lib/client-v1-contract');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('client-v1 manifest freezes the seven Mobile-entry route families', () => {
  assert.equal(CLIENT_V1_CONTRACT_ID, 'client-v1');
  assert.equal(CLIENT_V1_MEDIA_TYPE, 'application/vnd.agent-calendar.client-v1+json');
  assert.equal(CLIENT_V1_RESPONSE_HEADER, 'x-agent-calendar-contract');
  assert.equal(clientV1ContractManifest.contractId, CLIENT_V1_CONTRACT_ID);
  assert.deepEqual(clientV1ContractManifest.audiences, ['desktop', 'mobile']);
  assert.deepEqual(
    clientV1ContractManifest.families.map((family) => family.id),
    [
      'identity',
      'unified-calendar',
      'calendar-ai',
      'agent-work',
      'automation',
      'knowledge',
      'notifications',
    ],
  );
  assert.equal(clientV1ContractManifest.compatibility.breakingChange, 'new-major-contract');
  assert.equal(clientV1ContractManifest.compatibility.withinMajor, 'additive-only');
  assert.deepEqual(
    clientV1ContractManifest.streams.agentWork.events,
    ['accepted', 'delta', 'checkpoint', 'error', 'done'],
  );
  assert.deepEqual(clientV1ContractManifest.streams.notifications.events, ['message']);
  assertDeepFrozen(clientV1ContractManifest);

  const operationIds = clientV1ContractManifest.families
    .flatMap((family) => family.operations.map((operation) => operation.id));
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.ok(operationIds.length >= 45);
  assert.ok(operationIds.includes('calendar.schedule-ingest'));
});

test('client-v1 manifest matches the production registry and fails closed on drift', () => {
  const routes = listProductionRoutes();
  const result = assertClientV1Contract(routes);
  assert.equal(result.ok, true);
  assert.equal(result.contractId, CLIENT_V1_CONTRACT_ID);

  const frozen = clientV1ContractManifest.families
    .flatMap((family) => family.operations)
    .find((operation) => operation.persistence === 'write' && operation.idempotent);
  assert.ok(frozen);

  const removed = routes.filter((route) => !(
    route.method === frozen.method && route.pathPattern === frozen.pathPattern
  ));
  assert.throws(
    () => assertClientV1Contract(removed),
    /client_v1_route_missing/,
  );

  const drifted = routes.map((route) => (
    route.method === frozen.method && route.pathPattern === frozen.pathPattern
      ? { ...route, role: route.role === 'member' ? 'owner' : 'member' }
      : route
  ));
  assert.throws(
    () => assertClientV1Contract(drifted),
    /client_v1_route_drift/,
  );
});

test('client-v1 negotiation accepts its media type and rejects only explicit unsupported contracts', () => {
  assert.deepEqual(negotiateClientContract({}), {
    requested: false,
    supported: true,
    contractId: null,
  });
  assert.deepEqual(negotiateClientContract({ accept: 'application/json' }), {
    requested: false,
    supported: true,
    contractId: null,
  });
  assert.deepEqual(negotiateClientContract({
    accept: `application/json, ${CLIENT_V1_MEDIA_TYPE}; q=1`,
  }), {
    requested: true,
    supported: true,
    contractId: CLIENT_V1_CONTRACT_ID,
  });
  assert.deepEqual(negotiateClientContract({
    'x-agent-calendar-contract': CLIENT_V1_CONTRACT_ID,
    accept: 'text/event-stream',
  }), {
    requested: true,
    supported: true,
    contractId: CLIENT_V1_CONTRACT_ID,
  });
  assert.deepEqual(negotiateClientContract({
    accept: 'application/vnd.agent-calendar.client-v2+json',
  }), {
    requested: true,
    supported: false,
    contractId: 'client-v2',
  });
});

test('negotiated client-v1 mutations require a retry-stable idempotency key', () => {
  assert.deepEqual(validateClientV1Request({
    method: 'POST',
    pathname: '/api/calendar/events',
    headers: { 'x-agent-calendar-contract': CLIENT_V1_CONTRACT_ID },
  }), {
    ok: false,
    status: 400,
    error: 'client_idempotency_key_required',
    contractId: CLIENT_V1_CONTRACT_ID,
  });
  assert.deepEqual(validateClientV1Request({
    method: 'POST',
    pathname: '/api/calendar/events',
    headers: {
      'x-agent-calendar-contract': CLIENT_V1_CONTRACT_ID,
      'idempotency-key': 'calendar-create-01',
    },
  }), {
    ok: true,
    status: 200,
    contractId: CLIENT_V1_CONTRACT_ID,
  });
  assert.deepEqual(validateClientV1Request({
    method: 'POST',
    pathname: '/api/phase1/auth/desktop/start',
    headers: { 'x-agent-calendar-contract': CLIENT_V1_CONTRACT_ID },
  }), {
    ok: true,
    status: 200,
    contractId: CLIENT_V1_CONTRACT_ID,
  });
});

test('real production HTTP advertises client-v1 and returns 406 for an unsupported explicit contract', async () => {
  const server = createRailwayGatewayServer({
    env: {
      WORKSPACE_AUTH_MODE: 'production',
      AGENT_CALENDAR_OBSERVABILITY_LOGS: '0',
    },
  });
  const baseUrl = await listen(server);
  try {
    const manifestResponse = await fetch(`${baseUrl}/api/contracts/client-v1`);
    assert.equal(manifestResponse.status, 200);
    assert.equal(
      manifestResponse.headers.get(CLIENT_V1_RESPONSE_HEADER),
      CLIENT_V1_CONTRACT_ID,
    );
    const manifestBody = await manifestResponse.json();
    assert.equal(manifestBody.contractId, CLIENT_V1_CONTRACT_ID);
    assert.equal(JSON.stringify(manifestBody).includes('workspaceId'), false);
    assert.equal(JSON.stringify(manifestBody).includes('providerCredential'), false);

    const negotiatedResponse = await fetch(`${baseUrl}/api/gateway-status`, {
      headers: { accept: `${CLIENT_V1_MEDIA_TYPE}, application/json` },
    });
    assert.equal(negotiatedResponse.status, 200);
    assert.equal(
      negotiatedResponse.headers.get(CLIENT_V1_RESPONSE_HEADER),
      CLIENT_V1_CONTRACT_ID,
    );
    assert.match(negotiatedResponse.headers.get('vary') || '', /accept/i);

    const unsupportedResponse = await fetch(`${baseUrl}/api/gateway-status`, {
      headers: { accept: 'application/vnd.agent-calendar.client-v2+json' },
    });
    assert.equal(unsupportedResponse.status, 406);
    assert.deepEqual(await unsupportedResponse.json(), {
      ok: false,
      error: 'client_contract_not_acceptable',
      message: 'not_acceptable',
      requestedContract: 'client-v2',
      supportedContracts: [CLIENT_V1_CONTRACT_ID],
    });

    const legacyResponse = await fetch(`${baseUrl}/api/gateway-status`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(legacyResponse.status, 200);
    assert.equal(legacyResponse.headers.get(CLIENT_V1_RESPONSE_HEADER), null);

    const missingKeyResponse = await fetch(`${baseUrl}/api/calendar/events`, {
      method: 'POST',
      headers: {
        accept: `${CLIENT_V1_MEDIA_TYPE}, application/json`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'contract test' }),
    });
    assert.equal(missingKeyResponse.status, 400);
    assert.equal((await missingKeyResponse.json()).error, 'client_idempotency_key_required');
  } finally {
    await close(server);
  }
});
