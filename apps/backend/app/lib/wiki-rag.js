const DEFAULT_EMBEDDING_DIMENSIONS = 256;

function normalizeText(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase();
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

function createEmbedding(text = '', dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    vector[index] += (hash & 1) ? 1 : -1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
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

function lexicalScore(question = '', content = '') {
  const queryTokens = new Set(tokenize(question));
  if (!queryTokens.size) return 0;
  const haystack = normalizeText(content);
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

function chunkText(text = '', { maxLength = 1200, overlap = 120 } = {}) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];
  const chunks = [];
  let offset = 0;
  while (offset < normalized.length) {
    const slice = normalized.slice(offset, offset + maxLength);
    chunks.push(slice.trim());
    if (offset + maxLength >= normalized.length) break;
    offset += Math.max(1, maxLength - overlap);
  }
  return chunks.filter(Boolean);
}

function excerpt(content = '', length = 260) {
  return String(content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, length);
}

function chunksFromDocument(document = {}) {
  const title = String(document.title || document.name || document.filename || document.wikiPath || 'Untitled document').trim();
  const content = [
    title,
    document.extractedText || document.extract || document.content || document.text || '',
    document.summary || '',
  ].filter(Boolean).join('\n\n');
  const path = String(document.wikiPath || document.path || '').trim();
  return chunkText(content).map((chunk, index) => ({
    id: `${document.id || path || title}:chunk:${index}`,
    source: 'document',
    sourceId: String(document.id || path || title),
    documentId: String(document.id || ''),
    path,
    title,
    chunkIndex: index,
    content: chunk,
    excerpt: excerpt(chunk),
    embedding: createEmbedding(`${title}\n${chunk}`),
    metadata: {
      source: document.source || '',
      createdAt: document.createdAt || '',
      updatedAt: document.updatedAt || '',
    },
  }));
}

function chunksFromWikiNotes(notes = []) {
  return (Array.isArray(notes) ? notes : []).flatMap((note) => {
    const title = String(note.title || note.path || 'Untitled note').trim();
    const path = String(note.path || '').trim();
    const content = [title, note.content || note.excerpt || ''].filter(Boolean).join('\n\n');
    return chunkText(content).map((chunk, index) => ({
      id: `${path || title}:chunk:${index}`,
      source: 'wiki-note',
      sourceId: path || title,
      documentId: '',
      path,
      title,
      chunkIndex: index,
      content: chunk,
      excerpt: excerpt(chunk),
      embedding: createEmbedding(`${title}\n${chunk}`),
      metadata: {
        updatedAt: note.updatedAt || '',
        bytes: note.bytes || 0,
      },
    }));
  });
}

function parseEmbedding(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rankWikiChunks(question = '', chunks = [], { limit = 5, path = '' } = {}) {
  const queryVector = createEmbedding(question);
  const pathPrefix = String(path || '').trim();
  return (Array.isArray(chunks) ? chunks : [])
    .filter((chunk) => {
      if (!pathPrefix) return true;
      const chunkPath = String(chunk.path || '');
      return chunkPath === pathPrefix || chunkPath.startsWith(`${pathPrefix}/`);
    })
    .map((chunk) => {
      const embedding = parseEmbedding(chunk.embedding);
      const content = [chunk.title, chunk.content, chunk.excerpt].filter(Boolean).join('\n');
      const vectorScore = cosineSimilarity(queryVector, embedding);
      const textScore = lexicalScore(question, content);
      return {
        ...chunk,
        score: Number((vectorScore * 0.68 + textScore * 0.32).toFixed(6)),
        vectorScore: Number(vectorScore.toFixed(6)),
        textScore: Number(textScore.toFixed(6)),
        excerpt: chunk.excerpt || excerpt(chunk.content || ''),
      };
    })
    .sort((a, b) => (b.score - a.score) || String(a.path || '').localeCompare(String(b.path || ''), 'ko'))
    .slice(0, Math.max(1, Number(limit) || 5));
}

function buildRetrievalOnlyAnswer(question = '', sources = []) {
  if (!sources.length) {
    return '서버 위키 인덱스에서 관련 문서를 찾지 못했습니다. 먼저 문서나 저널을 저장한 뒤 다시 질문해주세요.';
  }
  const lines = sources.slice(0, 3).map((source, index) => {
    const label = source.title || source.path || `source ${index + 1}`;
    return `${index + 1}. ${label}: ${excerpt(source.content || source.excerpt || '', 360)}`;
  });
  return [`서버 DB 검색 기준으로 답변합니다.`, `질문: ${question}`, ...lines].join('\n\n');
}

function openAiKey(env = process.env) {
  return String(env.OPENAI_API_KEY || env.HERMES_OPENAI_API_KEY || env.AGENT_CALENDAR_OPENAI_API_KEY || '').trim();
}

function openAiModel(env = process.env) {
  return String(env.OPENAI_CHAT_MODEL || env.HERMES_OPENAI_CHAT_MODEL || env.AGENT_CALENDAR_OPENAI_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
}

function localLlmModel(env = process.env) {
  return String(
    env.AGENT_CALENDAR_LOCAL_LLM_MODEL
    || env.HERMES_LOCAL_LLM_MODEL
    || env.LOCAL_LLM_MODEL
    || env.OLLAMA_MODEL
    || 'qwen2.5:7b'
  ).trim() || 'qwen2.5:7b';
}

function openAiBaseUrl(env = process.env) {
  return String(env.OPENAI_BASE_URL || env.HERMES_OPENAI_BASE_URL || env.AGENT_CALENDAR_OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/g, '');
}

function openAiOAuthUrl(env = process.env) {
  return String(
    env.AGENT_CALENDAR_OPENAI_OAUTH_URL
    || env.HERMES_OPENAI_OAUTH_URL
    || env.OPENAI_OAUTH_URL
    || env.RAILWAY_SERVICE_OPENAI_OAUTH_URL
    || ''
  ).trim().replace(/\/+$/g, '');
}

function openAiOAuthKey(env = process.env) {
  return String(
    env.AGENT_CALENDAR_OPENAI_OAUTH_PROXY_API_KEY
    || env.HERMES_OPENAI_OAUTH_PROXY_API_KEY
    || env.OPENAI_OAUTH_PROXY_API_KEY
    || env.PROXY_API_KEY
    || ''
  ).trim();
}

function localLlmUrl(env = process.env) {
  return String(
    env.AGENT_CALENDAR_LOCAL_LLM_URL
    || env.HERMES_LOCAL_LLM_URL
    || env.LOCAL_LLM_URL
    || env.OLLAMA_BASE_URL
    || ''
  ).trim().replace(/\/+$/g, '');
}

function localLlmKey(env = process.env) {
  return String(
    env.AGENT_CALENDAR_LOCAL_LLM_API_KEY
    || env.HERMES_LOCAL_LLM_API_KEY
    || env.LOCAL_LLM_API_KEY
    || ''
  ).trim();
}

function openAiCompatibleBaseUrl(value = '') {
  const baseUrl = String(value || '').trim().replace(/\/+$/g, '');
  if (!baseUrl) return '';
  return /\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function wikiLlmConfigs(env = process.env) {
  const configs = [];
  const oauthUrl = openAiOAuthUrl(env);
  const oauthKey = openAiOAuthKey(env);
  if (oauthUrl && oauthKey) {
    configs.push({
      provider: 'openai-oauth',
      errorPrefix: 'openai_oauth_request_failed',
      baseUrl: openAiCompatibleBaseUrl(oauthUrl),
      apiKey: oauthKey,
      model: openAiModel(env),
    });
  }
  const localUrl = localLlmUrl(env);
  if (localUrl) {
    configs.push({
      provider: 'local-llm',
      errorPrefix: 'local_llm_request_failed',
      baseUrl: openAiCompatibleBaseUrl(localUrl),
      apiKey: localLlmKey(env),
      model: localLlmModel(env),
    });
  }
  const apiKey = openAiKey(env);
  if (apiKey) {
    configs.push({
      provider: 'openai',
      errorPrefix: 'openai_request_failed',
      baseUrl: openAiBaseUrl(env),
      apiKey,
      model: openAiModel(env),
    });
  }
  return configs;
}

async function synthesizeWithConfig({ llm, question, sources, fetchImpl = fetch } = {}) {
  if (!llm) return null;
  const context = sources.map((source, index) => (
    `[${index + 1}] ${source.title || source.path}\npath: ${source.path || ''}\n${source.content || source.excerpt || ''}`
  )).join('\n\n');
  const headers = {
    'content-type': 'application/json',
  };
  if (llm.apiKey) headers.authorization = `Bearer ${llm.apiKey}`;
  const response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: llm.model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You answer from the provided Hermes LLM-Wiki retrieval context. If context is insufficient, say so directly. Answer in Korean.',
        },
        {
          role: 'user',
          content: `질문:\n${question}\n\n검색 컨텍스트:\n${context}`,
        },
      ],
    }),
  });
  if (!response.ok) {
    const text = typeof response.text === 'function' ? await response.text() : '';
    const error = new Error(`${llm.errorPrefix}:${response.status}:${text.slice(0, 160)}`);
    error.llm = llm;
    throw error;
  }
  const payload = await response.json();
  const answer = String(payload?.choices?.[0]?.message?.content || '').trim();
  return answer ? { answer, llm: { provider: llm.provider, model: llm.model, used: true } } : null;
}

async function synthesizeWikiAnswer({ question, sources, env = process.env, fetchImpl = fetch } = {}) {
  const configs = wikiLlmConfigs(env);
  if (!configs.length) return null;
  const attempts = [];
  for (const llm of configs) {
    try {
      const synthesis = await synthesizeWithConfig({
        llm,
        question,
        sources,
        fetchImpl,
      });
      if (synthesis?.answer) {
        return {
          ...synthesis,
          attempts: [
            ...attempts,
            { provider: llm.provider, model: llm.model, used: true },
          ],
        };
      }
      attempts.push({ provider: llm.provider, model: llm.model, used: false, error: 'empty_llm_answer' });
    } catch (error) {
      attempts.push({
        provider: llm.provider,
        model: llm.model,
        used: false,
        error: error.message || String(error),
      });
    }
  }
  const error = new Error(attempts.map((attempt) => attempt.error).filter(Boolean).join(' | ') || 'llm_unavailable');
  error.llm = attempts[attempts.length - 1] || configs[configs.length - 1];
  error.attempts = attempts;
  throw error;
}

async function answerWikiQuestion({
  question,
  path = '',
  limit = 5,
  store = null,
  wikiIndex = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const normalizedQuestion = String(question || '').trim();
  const resolvedLimit = Math.max(1, Number(limit) || 5);
  if (!normalizedQuestion) {
    return {
      ok: false,
      error: 'question_required',
      answer: '질문을 입력해주세요.',
      sources: [],
      retrieval: { source: 'server-db', mode: 'empty-question', chunkCount: 0 },
      llm: { provider: 'none' },
    };
  }

  if (store && typeof store.indexWikiNotes === 'function' && wikiIndex && Array.isArray(wikiIndex.notes)) {
    await store.indexWikiNotes(wikiIndex.notes);
  }

  let source = 'wiki-files';
  let chunks = [];
  if (store && typeof store.searchWikiChunks === 'function') {
    source = 'server-db';
    chunks = await store.searchWikiChunks(normalizedQuestion, { limit: resolvedLimit, path });
  } else {
    chunks = rankWikiChunks(normalizedQuestion, chunksFromWikiNotes(wikiIndex?.ragNotes || wikiIndex?.notes || []), { limit: resolvedLimit, path });
  }

  const sources = chunks.slice(0, resolvedLimit).map((chunk) => ({
    id: chunk.id,
    path: chunk.path,
    title: chunk.title || chunk.path,
    excerpt: chunk.excerpt || excerpt(chunk.content || ''),
    content: chunk.content || '',
    score: chunk.score || 0,
    vectorScore: chunk.vectorScore || 0,
    textScore: chunk.textScore || 0,
    source: chunk.source || '',
  }));

  let llm = { provider: 'none', used: false };
  let llmAttempts = null;
  let answer = '';
  if (sources.length) {
    try {
      const synthesis = await synthesizeWikiAnswer({
        question: normalizedQuestion,
        sources,
        env,
        fetchImpl,
      });
      if (synthesis) {
        answer = synthesis.answer;
        llm = synthesis.llm;
        llmAttempts = synthesis.attempts || null;
      }
    } catch (error) {
      llm = {
        provider: error.llm?.provider || 'openai',
        model: error.llm?.model || '',
        used: false,
        error: error.message || 'llm_request_failed',
      };
      llmAttempts = error.attempts || null;
    }
  }
  if (!answer) answer = buildRetrievalOnlyAnswer(normalizedQuestion, sources);

  return {
    ok: true,
    answer,
    sources: sources.map(({ content, ...sourceItem }) => sourceItem),
    retrieval: {
      source,
      mode: llm.used ? 'rag' : 'retrieval_only',
      chunkCount: sources.length,
    },
    llm,
    ...(llmAttempts ? { llmAttempts } : {}),
  };
}

module.exports = {
  answerWikiQuestion,
  buildRetrievalOnlyAnswer,
  chunksFromDocument,
  chunksFromWikiNotes,
  createEmbedding,
  rankWikiChunks,
};
