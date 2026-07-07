const DEFAULT_EMBEDDING_DIMENSIONS = 256;
const DEFAULT_EMBEDDING_MODEL = 'bge-m3';

function text(value, fallback = '') {
  return String(value || fallback);
}

function normalizeText(value = '') {
  return text(value).normalize('NFKC').toLowerCase();
}

function tokenize(value = '') {
  const normalized = normalizeText(value);
  const words = normalized.match(/[a-z0-9가-힣]+/g) || [];
  const grams = [];
  for (const word of words) {
    if (word.length <= 2) continue;
    for (let index = 0; index <= word.length - 2; index += 1) {
      grams.push(word.slice(index, index + 2));
    }
  }
  return [...words, ...grams];
}

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashEmbedding(value = '', dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  for (const token of tokenize(value)) {
    const hash = hashToken(token);
    vector[hash % dimensions] += hash & 1 ? 1 : -1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, entry) => sum + entry * entry, 0)) || 1;
  return vector.map((entry) => Number((entry / magnitude).toFixed(6)));
}

function cosineSimilarity(left = [], right = []) {
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function embeddingModel(env = process.env, explicit = '') {
  return text(
    explicit
    || env.AGENT_CALENDAR_EMBEDDING_MODEL
    || env.HERMES_EMBEDDING_MODEL
    || env.OLLAMA_EMBEDDING_MODEL
    || DEFAULT_EMBEDDING_MODEL,
  ).trim() || DEFAULT_EMBEDDING_MODEL;
}

function ollamaBaseUrl(env = process.env, explicit = '') {
  // LOCAL_LLM_URL 계열은 OpenAI 호환 경로(/v1)일 수 있어 Ollama 네이티브
  // /api/embeddings 호출을 위해 /v1 접미사는 제거한다.
  return text(
    explicit
    || env.AGENT_CALENDAR_OLLAMA_URL
    || env.HERMES_OLLAMA_URL
    || env.OLLAMA_BASE_URL
    || env.AGENT_CALENDAR_LOCAL_LLM_URL
    || env.HERMES_LOCAL_LLM_URL
    || env.LOCAL_LLM_URL,
  ).trim().replace(/\/+$/g, '').replace(/\/v1$/i, '');
}

function fallbackResult(input, error = null) {
  return {
    vector: hashEmbedding(input),
    model: 'hash-fallback',
    fallback: true,
    ...(error ? { error: error.message || String(error) } : {}),
  };
}

async function embedTextWithMetadata(input = '', options = {}) {
  const prompt = text(input);
  const model = embeddingModel(options.env || process.env, options.model);
  const baseUrl = ollamaBaseUrl(options.env || process.env, options.baseUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 3000) || 3000);
  if (!baseUrl) return fallbackResult(prompt);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model, prompt }),
    });
    if (!response.ok) {
      const body = typeof response.text === 'function' ? await response.text() : '';
      return fallbackResult(prompt, new Error(`ollama_embeddings_failed:${response.status}:${body.slice(0, 120)}`));
    }
    const payload = await response.json();
    const vector = Array.isArray(payload?.embedding) ? payload.embedding.map(Number).filter(Number.isFinite) : [];
    if (!vector.length) return fallbackResult(prompt, new Error('ollama_embeddings_empty_vector'));
    return {
      vector,
      model,
      fallback: false,
    };
  } catch (error) {
    return fallbackResult(prompt, controller.signal.aborted ? new Error(`ollama_embeddings_timeout:${timeoutMs}`) : error);
  } finally {
    clearTimeout(timeout);
  }
}

async function embedText(input = '', options = {}) {
  const result = await embedTextWithMetadata(input, options);
  return result.vector;
}

async function embedBatchWithMetadata(inputs = [], options = {}) {
  const texts = Array.isArray(inputs) ? inputs : [];
  const results = [];
  for (const input of texts) {
    results.push(await embedTextWithMetadata(input, options));
  }
  return results;
}

async function embedBatch(inputs = [], options = {}) {
  const results = await embedBatchWithMetadata(inputs, options);
  return results.map((result) => result.vector);
}

module.exports = {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  cosineSimilarity,
  embedBatch,
  embedBatchWithMetadata,
  embedText,
  embedTextWithMetadata,
  hashEmbedding,
};
