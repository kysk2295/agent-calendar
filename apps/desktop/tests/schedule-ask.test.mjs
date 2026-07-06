import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiProxyServer } from '../dist-electron/proxy.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

test('proxy handles /api/assistant/ask locally with schedule vector retrieval and computed fallback', async () => {
  const calls = [];
  const tasks = [
    { id: 'shift-a', title: '카페 알바 오픈', date: '2026-06-10', time: '09:00', endTime: '13:00', status: 'Done', done: true, tags: ['알바'], category: '근무' },
    { id: 'shift-b', title: '카페 알바 마감', date: '2026-06-20', time: '18:00', endTime: '22:00', status: 'Done', done: true, tags: ['알바'], category: '근무' },
    { id: 'study-a', title: 'React 공부', date: '2026-06-21', status: 'Done', done: true, tags: ['공부'], category: '학습' },
  ];

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? String(init.body) : '' });
    if (parsed.pathname === '/api/tasks') {
      return new Response(JSON.stringify({ ok: true, tasks, data: { tasks } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (parsed.pathname === '/api/calendar/events') {
      return new Response(JSON.stringify({ ok: true, events: [], data: { events: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (parsed.pathname === '/api/chat/stream') {
      return new Response('Railway unavailable', { status: 503 });
    }
    return new Response(JSON.stringify({ ok: false, error: `unexpected ${parsed.pathname}` }), { status: 404, headers: { 'content-type': 'application/json' } });
  };

  const server = createApiProxyServer({
    getSettings: () => ({ apiBaseUrl: 'https://railway.example', apiToken: 'secret' }),
    fetchImpl,
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '3달간 알바 총 몇 시간 했지?' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.match(payload.answer, /8시간/);
    assert.equal(payload.computed.workHours, 8);
    assert.equal(payload.computed.workCount, 2);
    assert.equal(payload.search.strategy, 'schedule-vector');
    assert.equal(payload.sources.length, 2);
    assert.deepEqual(payload.sources.map((source) => source.id).sort(), ['shift-a', 'shift-b']);
    assert.equal(calls.some((call) => new URL(call.url).pathname === '/api/assistant/ask'), false);
    assert.equal(calls.some((call) => new URL(call.url).pathname === '/api/tasks'), true);
    assert.equal(calls.some((call) => new URL(call.url).pathname === '/api/calendar/events'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
