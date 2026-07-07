const {
  cosineSimilarity: sharedCosineSimilarity,
  embedTextWithMetadata,
} = require('./embeddings');

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

function wordTokens(value = '') {
  return normalizeText(value).match(/[a-z0-9가-힣]+/g) || [];
}

function titlePathScore(question = '', chunk = {}) {
  const queryWords = new Set(wordTokens(question).filter((token) => token.length > 1));
  if (!queryWords.size) return 0;
  const titlePath = normalizeText([chunk.title, chunk.path].filter(Boolean).join(' '));
  const titleWords = wordTokens([chunk.title, chunk.path].filter(Boolean).join(' ')).filter((token) => token.length > 1);
  if (!titleWords.length) return 0;
  let hits = 0;
  for (const token of queryWords) {
    if (titlePath.includes(token)) hits += 1;
  }
  let coverage = hits / queryWords.size;
  const meaningfulTitleWords = titleWords.filter((token) => !/md|wiki|raw|output/.test(token));
  if (meaningfulTitleWords.length && meaningfulTitleWords.every((token) => queryWords.has(token) || normalizeText(question).includes(token))) {
    coverage += 0.45;
  }
  return Math.min(1, coverage);
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

function markdownHeading(line = '') {
  const match = String(line || '').match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

function chunkMarkdown(text = '', { title = '', maxLength = 800, overlap = 80 } = {}) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const lines = normalized.split('\n');
  const sections = [];
  const headingStack = [];
  let current = { headingPath: String(title || '').trim(), lines: [] };
  const flush = () => {
    const content = current.lines.join('\n').trim();
    if (content) sections.push({ headingPath: current.headingPath || String(title || '').trim(), content });
  };
  for (const line of lines) {
    const heading = markdownHeading(line);
    if (heading) {
      flush();
      headingStack[heading.level - 1] = heading.title;
      headingStack.length = heading.level;
      current = {
        headingPath: headingStack.filter(Boolean).join(' > '),
        lines: [line],
      };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  const sourceSections = sections.length ? sections : [{ headingPath: String(title || '').trim(), content: normalized }];
  return sourceSections.flatMap((section) => chunkText(section.content, { maxLength, overlap }).map((content) => ({
    headingPath: section.headingPath,
    content,
  })));
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
  return chunkMarkdown(content, { title }).map((chunk, index) => ({
    id: `${document.id || path || title}:chunk:${index}`,
    source: 'document',
    sourceId: String(document.id || path || title),
    documentId: String(document.id || ''),
    path,
    title,
    headingPath: chunk.headingPath,
    chunkIndex: index,
    content: chunk.content,
    excerpt: excerpt(chunk.content),
    embedding: createEmbedding(chunk.content),
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
    return chunkMarkdown(content, { title }).map((chunk, index) => ({
      id: `${path || title}:chunk:${index}`,
      source: 'wiki-note',
      sourceId: path || title,
      documentId: '',
      path,
      title,
      headingPath: chunk.headingPath,
      chunkIndex: index,
      content: chunk.content,
      excerpt: excerpt(chunk.content),
      embedding: createEmbedding(chunk.content),
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
      const content = [chunk.content, chunk.excerpt].filter(Boolean).join('\n');
      const vectorScore = cosineSimilarity(queryVector, embedding);
      const textScore = lexicalScore(question, content);
      const titleScore = titlePathScore(question, chunk);
      return {
        ...chunk,
        score: Number((vectorScore * 0.42 + textScore * 0.23 + titleScore * 0.35).toFixed(6)),
        vectorScore: Number(vectorScore.toFixed(6)),
        textScore: Number(textScore.toFixed(6)),
        titleScore: Number(titleScore.toFixed(6)),
        excerpt: chunk.excerpt || excerpt(chunk.content || ''),
      };
    })
    .sort((a, b) => (b.score - a.score) || String(a.path || '').localeCompare(String(b.path || ''), 'ko'))
    .slice(0, Math.max(1, Number(limit) || 5));
}

async function rankWikiChunksWithEmbeddings(question = '', chunks = [], { limit = 5, path = '', env = process.env, fetchImpl = fetch } = {}) {
  const resolvedLimit = Math.max(1, Number(limit) || 5);
  const pathPrefix = String(path || '').trim();
  const candidates = (Array.isArray(chunks) ? chunks : []).filter((chunk) => {
    if (!pathPrefix) return true;
    const chunkPath = String(chunk.path || '');
    return chunkPath === pathPrefix || chunkPath.startsWith(`${pathPrefix}/`);
  });
  const query = await embedTextWithMetadata(question, { env, fetchImpl });
  if (query.fallback) {
    return {
      chunks: rankWikiChunks(question, candidates, { limit: resolvedLimit, path: '' }),
      embeddingModel: 'hash-fallback',
    };
  }
  const fallbackModels = new Set(query.fallback ? ['hash-fallback'] : []);
  const ranked = [];
  for (const chunk of candidates) {
    const content = [chunk.content, chunk.excerpt].filter(Boolean).join('\n');
    const embedded = await embedTextWithMetadata(content, { env, fetchImpl });
    if (embedded.fallback) fallbackModels.add('hash-fallback');
    const vectorScore = Math.max(0, sharedCosineSimilarity(query.vector, embedded.vector));
    const textScore = lexicalScore(question, content);
    const titleScore = titlePathScore(question, chunk);
    ranked.push({
      ...chunk,
      score: Number((vectorScore * 0.60 + titleScore * 0.25 + textScore * 0.15).toFixed(6)),
      vectorScore: Number(vectorScore.toFixed(6)),
      textScore: Number(textScore.toFixed(6)),
      titleScore: Number(titleScore.toFixed(6)),
      excerpt: chunk.excerpt || excerpt(chunk.content || ''),
    });
  }
  return {
    chunks: ranked
      .sort((a, b) => (b.score - a.score) || String(a.path || '').localeCompare(String(b.path || ''), 'ko'))
      .slice(0, resolvedLimit),
    embeddingModel: fallbackModels.size ? 'hash-fallback' : query.model,
  };
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

function buildNoRetrievalAnswer(sources = []) {
  const closest = sources.slice(0, 3).map((source) => `「${source.title || source.path || '문서'}」`).join(', ');
  return closest
    ? `위키에서 관련 문서를 찾지 못했어요. 가장 가까운 문서는 ${closest}인데 질문과는 거리가 있어 보여요. 위키에 있는 내용으로 다시 질문해주시겠어요?`
    : '위키에서 관련 문서를 찾지 못했어요. 위키에 있는 내용으로 다시 질문해주시겠어요?';
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

function llmMaxTokens(env = process.env, provider = '') {
  const value = provider === 'local-llm'
    ? (env.AGENT_CALENDAR_LOCAL_LLM_MAX_TOKENS || env.HERMES_LOCAL_LLM_MAX_TOKENS || env.LOCAL_LLM_MAX_TOKENS || env.AGENT_CALENDAR_LLM_MAX_TOKENS || env.HERMES_LLM_MAX_TOKENS)
    : (env.AGENT_CALENDAR_LLM_MAX_TOKENS || env.HERMES_LLM_MAX_TOKENS || env.OPENAI_MAX_TOKENS);
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function llmTimeoutMs(env = process.env, provider = '') {
  const value = provider === 'openai-oauth'
    ? (env.AGENT_CALENDAR_OPENAI_OAUTH_TIMEOUT_MS || env.HERMES_OPENAI_OAUTH_TIMEOUT_MS || env.OPENAI_OAUTH_TIMEOUT_MS || env.AGENT_CALENDAR_LLM_TIMEOUT_MS || env.HERMES_LLM_TIMEOUT_MS)
    : provider === 'local-llm'
      ? (env.AGENT_CALENDAR_LOCAL_LLM_TIMEOUT_MS || env.HERMES_LOCAL_LLM_TIMEOUT_MS || env.LOCAL_LLM_TIMEOUT_MS || env.AGENT_CALENDAR_LLM_TIMEOUT_MS || env.HERMES_LLM_TIMEOUT_MS)
      : (env.AGENT_CALENDAR_OPENAI_TIMEOUT_MS || env.HERMES_OPENAI_TIMEOUT_MS || env.OPENAI_TIMEOUT_MS || env.AGENT_CALENDAR_LLM_TIMEOUT_MS || env.HERMES_LLM_TIMEOUT_MS);
  const parsed = Number(value || 45000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 45000;
}

function llmContextChars(env = process.env) {
  const parsed = Number(env.AGENT_CALENDAR_WIKI_LLM_CONTEXT_CHARS || env.HERMES_WIKI_LLM_CONTEXT_CHARS || 520);
  return Number.isFinite(parsed) && parsed > 120 ? Math.floor(parsed) : 520;
}

function compactLlmContext(value = '', maxLength = 520) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trim()}...`;
}

function preferWikiFiles(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.AGENT_CALENDAR_WIKI_PREFER_FILES || env.HERMES_WIKI_PREFER_FILES || '1'));
}

function wikiMinScore(env = process.env) {
  const parsed = Number(env.AGENT_CALENDAR_WIKI_MIN_SCORE || env.HERMES_WIKI_MIN_SCORE || 0.35);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.35;
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
      maxTokens: llmMaxTokens(env, 'openai-oauth'),
      timeoutMs: llmTimeoutMs(env, 'openai-oauth'),
      contextChars: llmContextChars(env),
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
      maxTokens: Math.max(llmMaxTokens(env, 'local-llm'), 700),
      timeoutMs: llmTimeoutMs(env, 'local-llm'),
      contextChars: llmContextChars(env),
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
      maxTokens: llmMaxTokens(env, 'openai'),
      timeoutMs: llmTimeoutMs(env, 'openai'),
      contextChars: llmContextChars(env),
    });
  }
  return configs;
}

async function synthesizeWithConfig({ llm, question, sources, fetchImpl = fetch } = {}) {
  if (!llm) return null;
  const context = sources.map((source, index) => (
    `[${index + 1}] ${source.title || source.path}\npath: ${source.path || ''}\n${compactLlmContext(source.excerpt || source.content || '', llm.contextChars || 520)}`
  )).join('\n\n');
  const headers = {
    'content-type': 'application/json',
  };
  if (llm.apiKey) headers.authorization = `Bearer ${llm.apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), llm.timeoutMs || 45000);
  let response;
  try {
    response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: llm.model,
        temperature: 0.2,
        ...(llm.maxTokens ? { max_tokens: llm.maxTokens } : {}),
        messages: [
          {
            role: 'system',
            content: [
              '너는 Hermes LLM-Wiki 검색 결과를 근거로 답하는 한국어 위키 AI다.',
              '반드시 한국어로만 답하라. 영어로 서론을 쓰거나 문서를 재구성하지 마라.',
              '사용자 질문에 직접 답하고, 제공된 검색 컨텍스트 밖의 내용은 추측하지 마라.',
              '각 문단 끝에 근거 문서를 (출처: 파일명 또는 제목) 형식으로 표기하라.',
              '질문이 문서 범위를 벗어나면, 아는 부분까지 답하고 나머지는 위키에 없다고 말하라.',
              '핵심 판단, 근거, 리스크나 다음 액션을 질문에 필요한 만큼만 포함하라.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `질문:\n${question}\n\n검색 컨텍스트:\n${context}`,
          },
        ],
      }),
    });
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') {
      const timeoutError = new Error(`${llm.errorPrefix}:timeout:${llm.timeoutMs || 45000}`);
      timeoutError.llm = llm;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = typeof response.text === 'function' ? await response.text() : '';
    const error = new Error(`${llm.errorPrefix}:${response.status}:${text.slice(0, 160)}`);
    error.llm = llm;
    throw error;
  }
  const payload = await response.json();
  const answer = String(payload?.choices?.[0]?.message?.content || '').trim();
  return answer ? {
    answer,
    answerMode: 'llm',
    llm: { provider: llm.provider, model: llm.model, used: true },
  } : null;
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
  synthesize = true,
} = {}) {
  const normalizedQuestion = String(question || '').trim();
  const resolvedLimit = Math.max(1, Number(limit) || 5);
  if (!normalizedQuestion) {
    return {
      ok: false,
      error: 'question_required',
      answer: '질문을 입력해주세요.',
      answerMode: 'no-retrieval',
      sources: [],
      retrieval: { source: 'server-db', mode: 'empty-question', chunkCount: 0 },
      llm: { provider: 'none' },
    };
  }

  if (!preferWikiFiles(env) && store && typeof store.indexWikiNotes === 'function' && wikiIndex && Array.isArray(wikiIndex.notes)) {
    await store.indexWikiNotes(wikiIndex.notes);
  }

  let source = 'wiki-files';
  let chunks = [];
  let embeddingModel = '';
  if (!preferWikiFiles(env) && store && typeof store.searchWikiChunks === 'function') {
    source = 'server-db';
    chunks = await store.searchWikiChunks(normalizedQuestion, { limit: resolvedLimit, path });
  } else {
    const ranked = await rankWikiChunksWithEmbeddings(normalizedQuestion, chunksFromWikiNotes(wikiIndex?.ragNotes || wikiIndex?.notes || []), {
      limit: resolvedLimit,
      path,
      env,
      fetchImpl,
    });
    chunks = ranked.chunks;
    embeddingModel = ranked.embeddingModel;
  }

  const sources = chunks.slice(0, resolvedLimit).map((chunk) => ({
    id: chunk.id,
    path: chunk.path,
    title: chunk.title || chunk.path,
    headingPath: chunk.headingPath || '',
    excerpt: chunk.excerpt || excerpt(chunk.content || ''),
    content: chunk.content || '',
    score: chunk.score || 0,
    vectorScore: chunk.vectorScore || 0,
    textScore: chunk.textScore || 0,
    source: chunk.source || '',
  }));

  const topScore = sources[0] ? Number(sources[0].score || 0) : 0;
  const minScore = wikiMinScore(env);
  if (!sources.length || topScore < minScore) {
    return {
      ok: true,
      answer: buildNoRetrievalAnswer(sources),
      answerMode: 'no-retrieval',
      sources: sources.map(({ content, ...sourceItem }) => sourceItem),
      retrieval: {
        source,
        mode: 'no-retrieval',
        chunkCount: sources.length,
        embeddingModel,
        minScore,
        topScore,
      },
      llm: { provider: 'none', used: false },
    };
  }

  let llm = { provider: 'none', used: false };
  let llmAttempts = null;
  let answer = '';
  let answerMode = sources.length ? 'retrieval-only' : 'no-retrieval';
  if (synthesize && sources.length) {
    try {
      const synthesis = await synthesizeWikiAnswer({
        question: normalizedQuestion,
        sources,
        env,
        fetchImpl,
      });
      if (synthesis) {
        answer = synthesis.answer;
        answerMode = synthesis.answerMode || 'llm';
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
    answerMode,
    sources: sources.map(({ content, ...sourceItem }) => sourceItem),
    retrieval: {
      source,
      mode: llm.used ? 'rag' : 'retrieval_only',
      chunkCount: sources.length,
      embeddingModel,
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
  rankWikiChunksWithEmbeddings,
};
