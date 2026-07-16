import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { createApiProxyServer } from '../dist-electron/proxy.js';

const PROXY_CREDENTIAL_HEADER = 'x-agent-calendar-proxy-credential';
const TEST_PROXY_CREDENTIAL = 'test-process-credential-that-is-never-an-owner-token';
const DEV_RENDERER_ORIGIN = 'http://127.0.0.1:5173';

async function withServer(fetchImpl, settings, fn) {
  const server = createApiProxyServer({
    allowedDevOrigin: DEV_RENDERER_ORIGIN,
    credential: TEST_PROXY_CREDENTIAL,
    fetchImpl,
    getSettings: () => settings,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function authenticatedFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      [PROXY_CREDENTIAL_HEADER]: TEST_PROXY_CREDENTIAL,
    },
  });
}

test('proxy forwards API path, query, method, body, and bearer token', async () => {
  const calls = [];
  await withServer(async (url, init) => {
    calls.push({ url, init, body: init.body ? Buffer.from(init.body).toString('utf8') : '' });
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }, {
    apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app',
    apiToken: 'secret-token',
  }, async (baseUrl) => {
    const response = await authenticatedFetch(`${baseUrl}/api/tasks?source=test`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer attacker-controlled-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'desktop task' }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hermes-os-production-e174.up.railway.app/api/tasks?source=test');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0].init.headers[PROXY_CREDENTIAL_HEADER], undefined);
  assert.equal(calls[0].body, '{"title":"desktop task"}');
});

test('proxy forwards schedule assistant asks to backend by default', async () => {
  const calls = [];
  await withServer(async (url, init) => {
    calls.push({ url, init, body: init.body ? Buffer.from(init.body).toString('utf8') : '' });
    return new Response(JSON.stringify({
      ok: true,
      answer: '백엔드 LLM 응답',
      llm: { provider: 'local-llm', model: 'qwen2.5:7b', used: true },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, {
    apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app',
    apiToken: 'secret-token',
  }, async (baseUrl) => {
    const response = await authenticatedFetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '이번 주 완료율?' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answer, '백엔드 LLM 응답');
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hermes-os-production-e174.up.railway.app/api/assistant/ask');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0].body, '{"question":"이번 주 완료율?"}');
});

test('proxy forwards multipart bytes and aborts upstream when renderer disconnects', async () => {
  const boundary = '----agent-calendar-boundary';
  const multipartBody = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="text"',
    '',
    '사진에서 일정 추출',
    `--${boundary}`,
    'Content-Disposition: form-data; name="image"; filename="schedule.png"',
    'Content-Type: image/png',
    '',
    'PNG_BYTES',
    `--${boundary}--`,
    '',
  ].join('\r\n'));
  let upstreamSignal;
  let forwardedBody = Buffer.alloc(0);
  let forwardedType = '';
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });

  await withServer(async (_url, init) => {
    upstreamSignal = init.signal;
    forwardedBody = Buffer.from(init.body);
    forwardedType = init.headers['content-type'];
    markStarted();
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  }, {
    apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app',
    apiToken: 'secret-token',
  }, async (baseUrl) => {
    const target = new URL('/api/assistant/ingest', baseUrl);
    const rendererRequest = request(target, {
      method: 'POST',
      headers: {
        [PROXY_CREDENTIAL_HEADER]: TEST_PROXY_CREDENTIAL,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(multipartBody.length),
      },
    });
    rendererRequest.on('error', () => {});
    rendererRequest.end(multipartBody);
    await started;
    rendererRequest.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.equal(forwardedType, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(forwardedBody, multipartBody);
  assert.equal(upstreamSignal?.aborted, true);
});

test('proxy preserves streaming responses', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"hel"}\n\n'));
      controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"lo"}\n\n'));
      controller.close();
    },
  });

  await withServer(async () => new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  }), {
    apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app',
    apiToken: '',
  }, async (baseUrl) => {
    const response = await authenticatedFetch(`${baseUrl}/api/chat/stream`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.equal(await response.text(), 'event: delta\ndata: {"text":"hel"}\n\nevent: delta\ndata: {"text":"lo"}\n\n');
  });
});

test('proxy answers preflight only for the configured dev renderer origin', async () => {
  let called = false;
  await withServer(async () => {
    called = true;
    return new Response('unused');
  }, {
    apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app',
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`, {
      method: 'OPTIONS',
      headers: {
        origin: DEV_RENDERER_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': `content-type,${PROXY_CREDENTIAL_HEADER}`,
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), DEV_RENDERER_ORIGIN);
    assert.match(response.headers.get('access-control-allow-headers') || '', /content-type/);
    assert.match(response.headers.get('access-control-allow-headers') || '', new RegExp(PROXY_CREDENTIAL_HEADER));
    assert.match(response.headers.get('vary') || '', /Origin/i);
  });

  assert.equal(called, false);
});

test('proxy rejects non API paths', async () => {
  await withServer(async () => new Response('unused'), {
    apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app',
  }, async (baseUrl) => {
    const response = await authenticatedFetch(`${baseUrl}/status`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).ok, false);
  });
});

test('proxy rejects an arbitrary browser origin before forwarding owner-authorized state changes', async () => {
  // Given
  const calls = [];
  await withServer(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  }, {
    apiBaseUrl: 'https://railway.example',
    apiToken: 'owner-bearer-must-stay-in-main',
  }, async (baseUrl) => {
    // When
    const response = await fetch(`${baseUrl}/api/agent-operations/work`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: 'https://attacker.example',
      },
      body: '{"objective":"steal owner authority"}',
    });

    // Then
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  });
  assert.equal(calls.length, 0);
});

test('proxy rejects missing and incorrect credentials even when the loopback port is known', async () => {
  // Given
  const calls = [];
  await withServer(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  }, {
    apiBaseUrl: 'https://railway.example',
    apiToken: 'owner-bearer-must-stay-in-main',
  }, async (baseUrl) => {
    // When
    const missing = await fetch(`${baseUrl}/api/agent-operations/work`, {
      method: 'POST',
      body: '{}',
    });
    const incorrect = await fetch(`${baseUrl}/api/agent-operations/work`, {
      method: 'POST',
      headers: { [PROXY_CREDENTIAL_HEADER]: 'wrong-process-credential' },
      body: '{}',
    });

    // Then
    assert.equal(missing.status, 401);
    assert.equal(incorrect.status, 401);
  });
  assert.equal(calls.length, 0);
});

test('proxy rejects a disallowed origin even when it presents the correct credential', async () => {
  // Given
  const calls = [];
  await withServer(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  }, {
    apiBaseUrl: 'https://railway.example',
    apiToken: 'owner-bearer-must-stay-in-main',
  }, async (baseUrl) => {
    // When
    const response = await authenticatedFetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
      body: '{}',
    });

    // Then
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
  assert.equal(calls.length, 0);
});

test('proxy denies attacker preflight and allows packaged null-origin preflight without forwarding', async () => {
  // Given
  let called = false;
  await withServer(async () => {
    called = true;
    return new Response('unused');
  }, {
    apiBaseUrl: 'https://railway.example',
  }, async (baseUrl) => {
    const requestedHeaders = `content-type,${PROXY_CREDENTIAL_HEADER}`;

    // When
    const attacker = await fetch(`${baseUrl}/api/state`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': requestedHeaders,
      },
    });
    const packaged = await fetch(`${baseUrl}/api/state`, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': requestedHeaders,
      },
    });

    // Then
    assert.equal(attacker.status, 403);
    assert.equal(attacker.headers.get('access-control-allow-origin'), null);
    assert.equal(packaged.status, 204);
    assert.equal(packaged.headers.get('access-control-allow-origin'), 'null');
    assert.match(packaged.headers.get('vary') || '', /Origin/i);
  });
  assert.equal(called, false);
});
