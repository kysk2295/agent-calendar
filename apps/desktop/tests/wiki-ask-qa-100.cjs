const { once } = require('node:events');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { createApiProxyServer } = require('../dist-electron/proxy.js');
const PROXY_CREDENTIAL = 'wiki-qa-process-credential';

const DEFAULT_VAULT = '/Users/koyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki';
const DEFAULT_RAILWAY = 'https://hermes-os-production-e174.up.railway.app';
const limit = Number(process.env.WIKI_QA_LIMIT || 100);
const concurrency = Math.max(1, Number(process.env.WIKI_QA_CONCURRENCY || 2));
const timeoutMs = Math.max(10_000, Number(process.env.WIKI_QA_TIMEOUT_MS || 150_000));
const reportDir = process.env.WIKI_QA_REPORT_DIR || path.join(process.cwd(), 'docs');

const questionBank = [
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort에서 지금 제일 중요한 병목은?'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort 로드맵에서 당장 실행해야 할 3가지는 뭐야?'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort 시스템 구조를 비개발자에게 설명해줘'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort 팀 협업 구조의 리스크는 뭐야?'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort 교육 렌더 구조에서 앱과 프리뷰는 어떻게 연결돼?'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort Discord Bot 명령 포맷의 핵심을 정리해줘'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort 사용자 확보에서 가장 먼저 검증할 가설은 뭐야?'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort 백로그를 보면 PM 관점에서 막힌 부분은 뭐야?'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort의 핵심 차별 루프를 설명해줘'],
  ['uniport', /UniPort|교육|팀백로그|로드맵|Discord|대학생|프로젝트/i, 'UniPort에서 내가 직접 책임져야 하는 부분은 어디까지로 보여?'],

  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, 'Market Flow Sentinel의 리스크 관리 원칙을 요약해줘'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, 'Market Flow Sentinel loop는 어떤 자동화야?'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, 'Market Analyst Agent의 핵심 임무는 뭐야?'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, 'Market Flow Sentinel에서 자동매매를 하지 않는 이유는 뭐야?'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, '시장 데이터 수집 실패 시 어떤 정책을 따라야 해?'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, '내 주식 관련 자동화에서 반복 실패를 줄이는 방법은?'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, 'Market Flow Sentinel과 stockagent는 어떻게 역할이 달라?'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, '투자 판단에서 위키가 말하는 가장 조심해야 할 점은?'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, 'Market Flow Sentinel을 매일 실행한다면 체크리스트는 어떻게 돼?'],
  ['market', /Market Flow|market|trading|stock|automation-registry|Sentinel|리스크|주식/i, '리스크 관리 원칙을 한 문장으로 압축해줘'],

  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Hermes OS Mac mini 연결 구조를 설명해줘'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Railway gateway와 Mac mini runtime은 어떻게 나뉘어 있어?'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Hermes relay 방식과 Funnel 방식의 차이는 뭐야?'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Hermes OS에서 gatewayFallback이 의미하는 건 뭐야?'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Mac mini connector setup에서 필수 조건은 뭐야?'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Hermes OS Mac mini handoff의 핵심 목표는?'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Hermes LaunchAgent 오류가 나면 어디부터 확인해야 해?'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Hermes API Server와 Railway gateway는 같은 거야 다른 거야?'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Hermes OS 구현 백로그에서 런타임 관련 남은 일은 뭐야?'],
  ['hermes', /Hermes|Mac mini|runtime|Railway|relay|connector|gateway|LaunchAgent/i, 'Mac mini runtime outage 문서가 말하는 교훈은 뭐야?'],

  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '내가 만들려는 세컨브레인 구조를 설명해줘'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '대화형 일기 세컨브레인의 핵심 아이디어는 뭐야?'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, 'LLM-Wiki 폴더 구조에서 민감한 영역은 어디야?'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '세컨브레인에서 검색과 답변 생성을 분리하는 이유는?'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '최근 중요한 질문으로 잡힌 것들을 정리해줘'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '위키 큐레이터 에이전트는 어떤 태도로 답해야 해?'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '일기와 위키를 분리해야 하는 이유를 설명해줘'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '나의 위키 기반 QA 앱은 어떤 제품으로 정의할 수 있어?'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '지금 위키 검색 기반 답변에서 가장 조심해야 할 UX는 뭐야?'],
  ['second-brain', /세컨브레인|일기|위키|LLM-Wiki|memory|conversation|journal/i, '위키에 근거가 부족할 때 어떻게 답해야 해?'],

  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, '위키 큐레이터 에이전트의 역할은 뭐야?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, '에이전트 프로필과 스킬은 어떻게 구분돼?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, 'marketflow 에이전트가 없으면 UI에 표시되면 안 되는 이유는?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, 'Hermes agent profile readiness는 왜 필요한가?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, '위키 큐레이터에게 답변 스킬을 주는 방식의 장점은?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, '새 LLM 에이전트가 아니라 Hermes를 답변 엔진으로 쓰는 이유는?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, '에이전트 실행 기록은 위키 어디에 남아야 해?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, '에이전트 답변이 고정 템플릿처럼 보이면 왜 문제야?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, '에이전트가 모르는 내용을 어떻게 말해야 해?'],
  ['agents', /agent|agents|profiles|skill|SOUL|wiki-curator|위키 큐레이터/i, '위키 큐레이터가 사용자의 감정적 질문에 답할 때 원칙은?'],

  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, 'automation-registry의 역할을 설명해줘'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, '반복 자동화에서 실패 로그를 남기는 이유는?'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, 'scheduler jobs는 Railway와 Mac mini 중 어디에서 실행돼?'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, '자동화가 실제 실행됐는지 확인하는 방법은?'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, 'Hermes 자동화에서 owner 승인 게이트가 필요한 작업은?'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, '반복 루프 자동화를 추가할 때 문서화해야 할 항목은?'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, 'Railway relay snapshot은 어떤 역할을 해?'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, 'Mac mini bridge가 끊기면 사용자는 무엇을 봐야 해?'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, '자동화가 같은 실수를 반복하지 않게 하려면?'],
  ['automation', /automation|scheduler|cron|loop|registry|자동화|LaunchAgent/i, 'scheduler와 agent run 기록은 어떻게 연결돼?'],

  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, 'Hermes OS 디자인 시스템의 핵심 원칙은?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, 'AI 디자인 구현 문서에서 중요한 내용은?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, '교육 렌더 프리뷰와 실제 앱 렌더의 차이는?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, 'Agent Calendar UI에서 mock data를 피해야 하는 이유는?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, 'Wiki Ask UI에서 citations를 어떻게 보여주는 게 좋아?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, '그래프 기반 위키 UI의 장점과 한계는?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, '프론트엔드에서 landing page보다 actual tool이 먼저 나와야 하는 이유는?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, 'Wiki Ask 답변 UI에서 사용자가 확인해야 하는 상태는?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, '검색 범위 토글 UX에서 일기 포함은 어떻게 다뤄야 해?'],
  ['design', /design|Figma|UI|UX|디자인|프리뷰|렌더/i, '답변이 중간에 끊겼을 때 UI는 어떻게 알려야 해?'],

  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, 'AI 데이터센터 리서치에서 핵심 포인트를 정리해줘'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, '논문 실험 연구 문서의 주요 방향은 뭐야?'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, 'bias parity benchmark가 다루는 문제는?'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, 'AI agent loop에 대해 위키가 말하는 핵심은?'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, 'Agentic Engineering 문서의 핵심을 요약해줘'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, 'reins engineering이 무엇인지 설명해줘'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, 'AI app factory 아이디어를 제품 관점에서 정리해줘'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, 'pmf signals startup ideas에서 얻을 수 있는 인사이트는?'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, 'anti-detect browser tools 문서의 핵심 리스크는?'],
  ['research', /research|논문|실험|AI|benchmark|리서치|데이터센터/i, '전기차 충전 인프라 문서의 주요 논지는?'],

  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '내 위키에서 지금 가장 많이 연결되는 주제는 뭐로 보여?'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '내가 최근 집중하는 프로젝트 축을 정리해줘'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '현재 위키에서 서로 연결해야 할 문서들은 뭐야?'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '위키 품질을 높이려면 어떤 문서를 먼저 정리해야 해?'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '내 작업 시스템에서 가장 큰 운영 리스크는?'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '지금 구조에서 로컬과 Railway의 책임을 구분해줘'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '위키 기반 답변 앱의 다음 개발 우선순위는?'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '검색 품질을 개선하려면 무엇부터 봐야 해?'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, '답변 근거가 부족할 때 앱은 어떻게 행동해야 해?'],
  ['meta', /wiki|Hermes|UniPort|Market|automation|agent|세컨브레인/i, 'Ask Wiki MVP가 성공했는지 판단하는 기준은?'],

  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, 'Ask Wiki 답변이 중간에 끊겼는지 판단하는 기준은 뭐야?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, 'Ask Wiki에서 citation 품질을 높이려면 어떤 메타데이터가 필요해?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, '검색 결과가 엉뚱한 문서를 먼저 가져올 때 어떻게 개선해야 해?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, 'Railway relay 답변 품질을 모니터링하려면 어떤 지표를 봐야 해?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, '위키 질문 테스트 보고서에는 어떤 항목이 들어가야 해?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, 'Ask Wiki가 mock이 아니라 실제 호출인지 어떻게 증명할 수 있어?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, '검색 chunk가 너무 짧거나 길 때 답변 품질에 어떤 문제가 생겨?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, '위키 큐레이터 답변이 GPT처럼 자연스럽게 보이려면 무엇을 피해야 해?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, 'QA 관점에서 gatewayFallback false만으로 충분하지 않은 이유는?'],
  ['qa', /wiki|Hermes|Railway|relay|source|citation|검색|답변/i, 'Ask Wiki MVP를 다음 단계로 안정화하려면 어떤 테스트를 자동화해야 해?'],
];

function answerFrom(payload) {
  return String(payload.answer || payload.text || payload.data?.answer || payload.data?.text || '');
}

function sourcesFrom(payload) {
  const sources = payload.sources || payload.citations || payload.data?.sources || payload.data?.citations || [];
  return Array.isArray(sources) ? sources : [];
}

function looksTruncated(answer) {
  const trimmed = answer.trim();
  if (!trimmed) return true;
  const withoutTrailingCitations = trimmed.replace(/(?:\s*\[[0-9]+\])+$/g, '').trim();
  if (/[.!?。！？…)\]]$/.test(trimmed)) return false;
  if (/(다|요|임|음|함|해|돼|야|어)$/.test(withoutTrailingCitations)) return false;
  if (/[,·:;(\-]$/.test(withoutTrailingCitations)) return true;
  const tail = withoutTrailingCitations.split(/\s+/).slice(-1)[0] || '';
  return tail.length >= 8 || /[A-Za-z]$/.test(tail);
}

function wantsConciseAnswer(question) {
  return /한\s*문장|짧게|압축|간단히|요약해줘/i.test(question);
}

function evaluate({ payload, question, answer, sources, expectedPattern }) {
  const failures = [];
  const warnings = [];
  const provider = payload.engine?.provider || payload.llm?.provider || '';
  const source = payload.engine?.source || payload.source || '';
  if (payload.gatewayFallback === true) failures.push('gatewayFallback=true');
  if (!/railway-hermes|hermes/i.test(provider)) failures.push(`unexpected provider=${provider || 'missing'}`);
  if (!/railway-relay|mac-mini-hermes-api|railway/i.test(source)) warnings.push(`unexpected engine source=${source || 'missing'}`);
  const minAnswerLength = wantsConciseAnswer(question) ? 40 : 80;
  if (answer.trim().length < minAnswerLength) failures.push(`short answer=${answer.trim().length}`);
  if (answer.trim().length > 1200) warnings.push(`long answer=${answer.trim().length}`);
  if (/undefined|null|\[object Object\]/i.test(answer)) failures.push('invalid placeholder text');
  if (/검색 결과 기반 임시 답변|답변 생성에 실패|본문이 비어|위키 답변 실패/i.test(answer)) failures.push('fallback/error answer text');
  if (/(^|\n)\s*(#{1,3}\s*)?(요약|근거|다음\s*행동)\s*[:：]?\s*(\n|$)/i.test(answer)) failures.push('rigid summary/evidence/next-action template');
  if (looksTruncated(answer)) failures.push('suspected truncation');
  if (!sources.length) failures.push('no sources');
  const sourceText = sources.map((sourceItem) => `${sourceItem.path || ''} ${sourceItem.title || ''} ${sourceItem.heading || ''}`).join('\n');
  if (expectedPattern && !expectedPattern.test(sourceText)) warnings.push('top sources may be off-topic');
  return { pass: failures.length === 0, failures, warnings };
}

async function askOne(endpoint, item, index) {
  const [topic, expectedPattern, question] = item;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-calendar-proxy-credential': PROXY_CREDENTIAL,
      },
      signal: controller.signal,
      body: JSON.stringify({ question, limit: 8, includeJournal: false, includeRaw: false, mode: 'smart' }),
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    const answer = answerFrom(payload);
    const sources = sourcesFrom(payload);
    const evaluation = evaluate({ payload, question, answer, sources, expectedPattern });
    return {
      index: index + 1,
      topic,
      question,
      httpStatus: response.status,
      ok: response.ok && payload.ok !== false,
      elapsedMs: Date.now() - started,
      answerLength: answer.length,
      answer,
      answerPreview: answer.slice(0, 260),
      sourceCount: sources.length,
      topSources: sources.slice(0, 5).map((sourceItem) => ({
        path: sourceItem.path || '',
        title: sourceItem.title || '',
        heading: sourceItem.heading || '',
        score: Number(sourceItem.score || 0),
      })),
      engine: payload.engine || payload.llm || {},
      gatewayFallback: payload.gatewayFallback,
      ...evaluation,
    };
  } catch (error) {
    return {
      index: index + 1,
      topic,
      question,
      ok: false,
      elapsedMs: Date.now() - started,
      answerLength: 0,
      answer: '',
      answerPreview: '',
      sourceCount: 0,
      topSources: [],
      engine: {},
      gatewayFallback: null,
      pass: false,
      failures: [error instanceof Error ? error.message : String(error)],
      warnings: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
      const result = results[index];
      const state = result.pass ? 'PASS' : 'FAIL';
      process.stdout.write(`[${result.index}/${items.length}] ${state} ${result.topic} ${result.elapsedMs}ms ${result.question}\n`);
      if (!result.pass) process.stdout.write(`  failures: ${result.failures.join(', ')}\n`);
      if (result.warnings.length) process.stdout.write(`  warnings: ${result.warnings.join(', ')}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

function pct(count, total) {
  return total ? Math.round((count / total) * 1000) / 10 : 0;
}

function markdownReport(summary, results) {
  const lines = [
    '# Wiki Ask QA Report',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Endpoint: ${summary.endpoint}`,
    `- Questions: ${summary.total}`,
    `- Pass: ${summary.pass} (${pct(summary.pass, summary.total)}%)`,
    `- Fail: ${summary.fail} (${pct(summary.fail, summary.total)}%)`,
    `- Warning: ${summary.warning}`,
    `- Average latency: ${summary.avgElapsedMs}ms`,
    `- p95 latency: ${summary.p95ElapsedMs}ms`,
    `- Truncation suspects: ${summary.truncationSuspects}`,
    `- Gateway fallback failures: ${summary.gatewayFallbackFailures}`,
    '',
    '## Failures',
    '',
  ];
  const failures = results.filter((result) => !result.pass);
  if (!failures.length) lines.push('- None');
  failures.forEach((result) => {
    lines.push(`- #${result.index} [${result.topic}] ${result.question}`);
    lines.push(`  - Failures: ${result.failures.join(', ')}`);
    lines.push(`  - Answer: ${result.answerPreview || '(empty)'}`);
  });
  lines.push('', '## Warnings', '');
  const warnings = results.filter((result) => result.warnings.length);
  if (!warnings.length) lines.push('- None');
  warnings.forEach((result) => {
    lines.push(`- #${result.index} [${result.topic}] ${result.question}`);
    lines.push(`  - Warnings: ${result.warnings.join(', ')}`);
    lines.push(`  - Top sources: ${result.topSources.map((sourceItem) => sourceItem.path).filter(Boolean).slice(0, 3).join(', ') || '(none)'}`);
  });
  lines.push('', '## Sample Answers', '');
  results.slice(0, 12).forEach((result) => {
    lines.push(`### #${result.index} ${result.question}`);
    lines.push('');
    lines.push(result.answer || '(empty)');
    lines.push('');
    lines.push(`Sources: ${result.topSources.map((sourceItem) => `${sourceItem.path} :: ${sourceItem.heading || sourceItem.title}`).join(' | ')}`);
    lines.push('');
  });
  return `${lines.join('\n')}\n`;
}

async function main() {
  const selected = questionBank.slice(0, Math.min(limit, questionBank.length));
  if (selected.length !== limit) {
    process.stderr.write(`Requested ${limit} questions but only ${selected.length} are available.\n`);
  }
  process.env.WIKI_ASK_LOCAL = '1';
  process.env.LLM_WIKI_VAULT = process.env.LLM_WIKI_VAULT || DEFAULT_VAULT;
  process.env.HERMES_WIKI_AGENT = process.env.HERMES_WIKI_AGENT || 'wiki-curator';

  const server = createApiProxyServer({
    credential: PROXY_CREDENTIAL,
    getSettings: () => ({
      apiBaseUrl: process.env.HERMES_RAILWAY_BASE_URL || DEFAULT_RAILWAY,
      apiToken: process.env.HERMES_RAILWAY_API_TOKEN || '',
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/wiki/ask`;
  const started = Date.now();
  let results;
  try {
    results = await runPool(selected, (item, index) => askOne(endpoint, item, index));
  } finally {
    server.close();
    await once(server, 'close');
  }

  const elapsedValues = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const total = results.length;
  const pass = results.filter((result) => result.pass).length;
  const fail = total - pass;
  const warning = results.filter((result) => result.warnings.length).length;
  const summary = {
    ok: fail === 0,
    endpoint,
    total,
    pass,
    fail,
    warning,
    avgElapsedMs: Math.round(results.reduce((sum, result) => sum + result.elapsedMs, 0) / Math.max(1, total)),
    p95ElapsedMs: elapsedValues[Math.min(elapsedValues.length - 1, Math.floor(elapsedValues.length * 0.95))] || 0,
    minAnswerLength: Math.min(...results.map((result) => result.answerLength)),
    maxAnswerLength: Math.max(...results.map((result) => result.answerLength)),
    truncationSuspects: results.filter((result) => result.failures.includes('suspected truncation')).length,
    gatewayFallbackFailures: results.filter((result) => result.gatewayFallback === true).length,
    elapsedMs: Date.now() - started,
  };
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(reportDir, `wiki-ask-qa-${stamp}.json`);
  const mdPath = path.join(reportDir, `wiki-ask-qa-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify({ summary, results }, null, 2));
  await writeFile(mdPath, markdownReport(summary, results));
  console.log(JSON.stringify({ summary, report: { jsonPath, mdPath } }, null, 2));
  if (process.env.WIKI_QA_STRICT === '1' && fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
