const assert = require('node:assert/strict');
const test = require('node:test');
const {
  embedBatch,
  embedBatchWithMetadata,
  embedText,
  embedTextWithMetadata,
} = require('../app/lib/embeddings');

test('embedTextWithMetadata calls Ollama embeddings endpoint and reports the model', async () => {
  const calls = [];
  const result = await embedTextWithMetadata('회의 일정', {
    baseUrl: 'http://ollama.test/',
    model: 'bge-m3',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(result.vector, [0.1, 0.2, 0.3]);
  assert.equal(result.model, 'bge-m3');
  assert.equal(result.fallback, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://ollama.test/api/embeddings');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'bge-m3', prompt: '회의 일정' });
});

test('embedText returns only the vector for callers that do not need metadata', async () => {
  const vector = await embedText('회의 일정', {
    baseUrl: 'http://ollama.test',
    fetchImpl: async () => new Response(JSON.stringify({ embedding: [1, 0] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  assert.deepEqual(vector, [1, 0]);
});

test('embedTextWithMetadata falls back to deterministic hash vector when Ollama fails', async () => {
  const first = await embedTextWithMetadata('회의 일정', {
    baseUrl: 'http://ollama.test',
    fetchImpl: async () => new Response('down', { status: 503 }),
  });
  const second = await embedTextWithMetadata('회의 일정', {
    baseUrl: 'http://ollama.test',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });

  assert.equal(first.model, 'hash-fallback');
  assert.equal(first.fallback, true);
  assert.equal(first.vector.length, 256);
  assert.deepEqual(first.vector, second.vector);
});

test('embedBatch preserves input order and exposes metadata', async () => {
  const prompts = [];
  const fetchImpl = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    prompts.push(body.prompt);
    return new Response(JSON.stringify({ embedding: body.prompt === '회의' ? [1, 0] : [0, 1] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const vectors = await embedBatch(['회의', '김치찌개'], { baseUrl: 'http://ollama.test', fetchImpl });
  const detailed = await embedBatchWithMetadata(['회의', '김치찌개'], { baseUrl: 'http://ollama.test', fetchImpl });

  assert.deepEqual(vectors, [[1, 0], [0, 1]]);
  assert.deepEqual(detailed.map((item) => item.vector), [[1, 0], [0, 1]]);
  assert.deepEqual(detailed.map((item) => item.model), ['bge-m3', 'bge-m3']);
  assert.deepEqual(prompts, ['회의', '김치찌개', '회의', '김치찌개']);
});

test('embedTextWithMetadata falls back to LOCAL_LLM_URL family and strips /v1 suffix', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ embedding: [0.25, -0.5, 0.75] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await embedTextWithMetadata('회의 일정', {
    env: { LOCAL_LLM_URL: 'http://mac-mini.local:11434/v1' },
    fetchImpl,
  });

  assert.equal(requests[0], 'http://mac-mini.local:11434/api/embeddings');
  assert.equal(result.fallback, false);
  assert.equal(result.model, 'bge-m3');
  assert.deepEqual(result.vector, [0.25, -0.5, 0.75]);
});
