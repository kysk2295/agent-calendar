import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApiProxyServer } from '../dist-electron/proxy.js';

async function withServer(fetchImpl, settings, fn) {
  const server = createApiProxyServer({ fetchImpl, getSettings: () => settings });
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
    const response = await fetch(`${baseUrl}/api/tasks?source=test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'desktop task' }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hermes-os-production-e174.up.railway.app/api/tasks?source=test');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');
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
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
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
    const response = await fetch(`${baseUrl}/api/chat/stream`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.equal(await response.text(), 'event: delta\ndata: {"text":"hel"}\n\nevent: delta\ndata: {"text":"lo"}\n\n');
  });
});

test('proxy answers browser preflight requests for dev renderer fetches', async () => {
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
        origin: 'http://127.0.0.1:5174',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-headers') || '', /content-type/);
  });

  assert.equal(called, false);
});

test('proxy rejects non API paths', async () => {
  await withServer(async () => new Response('unused'), {
    apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app',
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/status`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).ok, false);
  });
});
