import type { WikiChunk, WikiSearchRequest, WikiSearchResult } from './wikiTypes.js';

const DEFAULT_FOLDERS = ['2_wiki', '3_output', '5_conversation', '6_agents', '7_automation'];
const STOP_WORDS = new Set([
  '지금', '제일', '가장', '중요한', '뭐야', '무엇', '어떻게', '왜', '어디', '언제',
  '설명해줘', '정리해줘', '요약해줘', '말해줘', '알려줘', '에서', '으로', '에게',
  '한테', '그리고', '또는', '있는', '하는', '되는', '이다', '입니다', '이야',
  '한', '문장', '압축', '압축해줘', '답해줘', '답해', '포함해서',
]);
const KOREAN_SUFFIXES = [
  '에서는', '으로는', '에게는', '한테는', '이라는', '이라는', '이라면', '이라서',
  '에서', '으로', '로써', '에게', '한테', '보다', '까지', '부터', '처럼', '마다',
  '만큼', '라고', '라는', '이며', '이고', '인데', '하면', '해서', '하고',
  '은', '는', '이', '가', '을', '를', '의', '에', '도', '만', '와', '과', '로',
];

function tokenize(value: string): string[] {
  const rawTokens = value.toLowerCase().match(/[a-z0-9]+|[가-힣]+/g) || [];
  const tokens: string[] = [];

  rawTokens.forEach((token) => {
    let stem = '';
    for (const suffix of KOREAN_SUFFIXES) {
      if (token.length > suffix.length + 1 && token.endsWith(suffix)) {
        stem = token.slice(0, -suffix.length);
        break;
      }
    }
    if (STOP_WORDS.has(token) || (stem && STOP_WORDS.has(stem))) return;
    tokens.push(token);
    if (stem) tokens.push(stem);
  });

  return [...new Set(tokens)].filter((token) => token && !STOP_WORDS.has(token));
}

function allowedFolders(request: WikiSearchRequest) {
  const folders = new Set(request.folders?.length ? request.folders : DEFAULT_FOLDERS);
  if (request.includeJournal) folders.add('4_journal');
  if (request.includeRaw) folders.add('1_raw');
  return folders;
}

function expandQueryTokens(tokens: string[]) {
  const expanded = [...tokens];
  const tokenSet = new Set(tokens);
  if (tokenSet.has('리스크') && (tokenSet.has('관리') || tokenSet.has('원칙'))) {
    expanded.push('market', 'sentinel', 'analyst', '투자', '주식');
  }
  if (tokenSet.has('투자') && tokenSet.has('리스크')) {
    expanded.push('market', 'sentinel', 'analyst', '주식', '리스크');
  }
  if (tokenSet.has('투자') && (tokenSet.has('판단') || tokenSet.has('조심'))) {
    expanded.push('주식', '근거', '반대', '매매');
  }
  return [...new Set(expanded)];
}

function snippetFor(text: string, tokens: string[]) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const index = tokens
    .map((token) => lower.indexOf(token))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b)[0] || 0;
  return normalized.slice(Math.max(0, index - 60), index + 180);
}

export function searchWikiChunks(chunks: WikiChunk[], request: WikiSearchRequest): WikiSearchResult[] {
  const query = String(request.query || '').trim();
  if (!query) return [];

  const tokens = expandQueryTokens(tokenize(query));
  const namedTokens = tokens.filter((token) => /[a-z0-9]/.test(token) && token.length >= 3);
  if (!tokens.length) return [];
  const folders = allowedFolders(request);
  const docs = chunks.filter((chunk) => folders.has(chunk.folder));
  const docFreq = new Map<string, number>();

  docs.forEach((chunk) => {
    const unique = new Set(tokenize(`${chunk.path} ${chunk.title} ${chunk.heading} ${chunk.text}`));
    unique.forEach((token) => docFreq.set(token, (docFreq.get(token) || 0) + 1));
  });

  const scored = docs
    .map((chunk) => {
      const metadataText = `${chunk.path} ${chunk.title} ${chunk.heading} ${chunk.headingPath.join(' ')}`;
      const haystack = `${metadataText} ${chunk.text}`;
      const docTokens = tokenize(haystack);
      const lengthNorm = Math.max(1, Math.sqrt(docTokens.length));
      const metadataTokens = tokenize(metadataText);
      const metadataTokenSet = new Set(metadataTokens);
      const docTokenSet = new Set(docTokens);
      let score = tokens.reduce((sum, token) => {
        const tf = docTokens.filter((item) => item === token).length;
        if (!tf) return sum;
        const idf = Math.log(1 + docs.length / (1 + (docFreq.get(token) || 0)));
        const metadataBoost = metadataTokens.includes(token) ? 2.8 : 1;
        return sum + (tf * idf * metadataBoost) / lengthNorm;
      }, 0);
      const namedMetadataMatches = namedTokens.filter((token) => metadataTokenSet.has(token)).length;
      const namedBodyMatches = namedTokens.filter((token) => docTokenSet.has(token)).length;
      if (namedTokens.length && namedMetadataMatches) {
        score += namedMetadataMatches * 2.5;
      } else if (namedTokens.length && !namedBodyMatches) {
        score *= 0.55;
      }
      if (chunk.folder === '5_conversation' && tokens.some((token) => ['투자', '주식', 'market', 'sentinel', 'analyst', '리스크'].includes(token))) {
        const domainMetadataMatches = ['투자', '주식', 'market', 'sentinel', 'analyst', '리스크']
          .filter((token) => metadataTokenSet.has(token)).length;
        if (!domainMetadataMatches) score *= 0.35;
      }
      return { ...chunk, score, snippet: snippetFor(chunk.text, tokens) };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);

  const perFile = new Map<string, number>();
  const diversified: WikiSearchResult[] = [];
  for (const result of scored) {
    const count = perFile.get(result.path) || 0;
    if (count >= 2) continue;
    perFile.set(result.path, count + 1);
    diversified.push(result);
    if (diversified.length >= (request.limit || 8)) break;
  }

  return diversified;
}
