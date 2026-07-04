import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchWikiChunks } from '../dist-electron/wikiSearch.js';

const chunks = [
  { id: 'a1', path: '2_wiki/Market.md', folder: '2_wiki', title: 'Market', heading: '리스크 관리', headingPath: ['Market', '리스크 관리'], text: '투자에서 반복하는 실수는 손절을 늦추고 리스크 한도를 넘기는 것이다.' },
  { id: 'a2', path: '2_wiki/Market.md', folder: '2_wiki', title: 'Market', heading: '포지션', headingPath: ['Market', '포지션'], text: '포지션 크기는 변동성에 맞춘다.' },
  { id: 'b1', path: '4_journal/2026-07-04.md', folder: '4_journal', title: '일기', heading: '투자 감정', headingPath: ['일기', '투자 감정'], text: '오늘도 조급함 때문에 투자 결정을 서둘렀다.' },
  { id: 'c1', path: '1_raw/raw.md', folder: '1_raw', title: 'Raw', heading: 'Raw', headingPath: ['Raw'], text: '원본 로그 투자 실수' },
];

const intentChunks = [
  { id: 'u1', path: '2_wiki/UniPort-로드맵.md', folder: '2_wiki', title: 'UniPort 로드맵', heading: '초기 병목', headingPath: ['UniPort 로드맵', '초기 병목'], text: '사용자 확보와 핵심 차별 루프 검증이 현재 가장 중요한 병목이다.' },
  { id: 'u2', path: '2_wiki/UniPort-교육렌더구조.md', folder: '2_wiki', title: 'UniPort 교육 렌더 구조', heading: '앱과 프리뷰 연결', headingPath: ['UniPort 교육 렌더 구조', '앱과 프리뷰 연결'], text: '앱 렌더와 프리뷰는 같은 교육 콘텐츠 파일을 읽어 미러링한다.' },
  { id: 'u3', path: '2_wiki/UniPort-마케팅.md', folder: '2_wiki', title: 'UniPort 마케팅', heading: '핵심 차별 루프', headingPath: ['UniPort 마케팅', '핵심 차별 루프'], text: 'UniPort의 핵심 차별 루프는 그룹모의투자 재미와 커뮤니티 경쟁감을 제품 안에서 반복시키는 것이다.' },
  { id: 's1', path: '2_wiki/대화형 일기 세컨브레인.md', folder: '2_wiki', title: '대화형 일기 세컨브레인', heading: '현재 중요한 질문', headingPath: ['대화형 일기 세컨브레인', '현재 중요한 질문'], text: '지금 중요한 질문은 감정 패턴과 일기 루프를 점검하는 것이다.' },
  { id: 'h1', path: '2_wiki/Hermes-OS-Mac-mini-Handoff.md', folder: '2_wiki', title: 'Hermes OS Mac mini Handoff', heading: '중요한 주의', headingPath: ['Hermes OS Mac mini Handoff', '중요한 주의'], text: 'Railway gateway와 Mac mini runtime은 relay로 연결된다.' },
  { id: 'r1', path: '2_wiki/논문 실험 연구.md', folder: '2_wiki', title: '논문 실험 연구', heading: '핵심 차별 루프 질문', headingPath: ['논문 실험 연구', '핵심 차별 루프 질문'], text: '핵심 차별 루프 질문을 실험으로 검증한다. 핵심 차별 루프는 반복 실험의 대상이다.' },
];

const noisyChunks = [
  { id: 'm1', path: '6_agents/profiles/market-analyst.md', folder: '6_agents', title: 'Market Analyst Agent', heading: '핵심 임무', headingPath: ['Market Analyst Agent', '핵심 임무'], text: '투자와 주식 시장 이슈를 근거 중심으로 요약하고 확률, 리스크, 반대 근거를 분리한다. 자동매매와 즉흥 매수 매도 지시는 하지 않는다.' },
  { id: 'm2', path: '7_automation/automation-registry.md', folder: '7_automation', title: 'Automation Registry', heading: 'Market Flow Sentinel loop', headingPath: ['Automation Registry', 'Market Flow Sentinel loop'], text: 'Market Flow Sentinel morning brief는 리스크와 반대 근거를 점검하는 자동화다.' },
  { id: 'm3', path: '2_wiki/AI 투자 리서치.md', folder: '2_wiki', title: 'AI 투자 리서치', heading: '판단 원칙', headingPath: ['AI 투자 리서치', '판단 원칙'], text: '투자 판단에서 조심해야 할 점은 확증편향과 즉흥 매매이며, 근거와 반대 시나리오를 분리해야 한다.' },
  { id: 'n1', path: '5_conversation/agent-runs/realstream.md', folder: '5_conversation', title: '고유표식 REALSTREAM 포함해서 한 문장으로 실제 런타임 응답인지 답해줘', heading: 'Resume', headingPath: ['고유표식', 'Resume'], text: '고유표식 포함해서 한 문장으로 실제 런타임 응답인지 답해줘.' },
  { id: 'n2', path: '5_conversation/agent-runs/2026-06-29-chat-너는-뭘-할-수-있어.md', folder: '5_conversation', title: '너는 뭘 할 수 있어', heading: 'Goal', headingPath: ['너는 뭘 할 수 있어', 'Goal'], text: '위키를 읽고 사용자의 투자 판단 질문에 답할 수 있다.' },
];

test('search ranks matching chunks and excludes journal/raw by default', () => {
  const results = searchWikiChunks(chunks, { query: '투자 반복 실수 리스크', limit: 8 });
  assert.equal(results[0].id, 'a1');
  assert.equal(results.some((result) => result.folder === '4_journal'), false);
  assert.equal(results.some((result) => result.folder === '1_raw'), false);
  assert.match(results[0].snippet, /투자/);
});

test('search includes journal and raw only when requested', () => {
  const results = searchWikiChunks(chunks, { query: '투자 실수 조급함 원본', limit: 8, includeJournal: true, includeRaw: true });
  assert.equal(results.some((result) => result.folder === '4_journal'), true);
  assert.equal(results.some((result) => result.folder === '1_raw'), true);
});

test('search understands project names with Korean particles and ranks intent-specific wiki chunks first', () => {
  const results = searchWikiChunks(intentChunks, { query: 'UniPort에서 지금 제일 중요한 병목은?', limit: 4 });
  assert.equal(results[0].id, 'u1');
  assert.equal(results.some((result) => result.id === 's1' && results.indexOf(result) < results.findIndex((item) => item.id === 'u1')), false);
});

test('search prefers specific subject chunks over generic repeated words', () => {
  const results = searchWikiChunks(intentChunks, { query: 'UniPort 교육 렌더 구조에서 앱과 프리뷰는 어떻게 연결돼?', limit: 4 });
  assert.equal(results[0].id, 'u2');
});

test('search keeps named project intent above generic keyword-only matches', () => {
  const results = searchWikiChunks(intentChunks, { query: 'UniPort의 핵심 차별 루프를 설명해줘', limit: 4 });
  assert.equal(results[0].id, 'u3');
  assert.ok(results.findIndex((result) => result.id === 'u3') < results.findIndex((result) => result.id === 'r1'));
});

test('search ignores answer-format words so concise risk questions do not match runtime logs first', () => {
  const results = searchWikiChunks(noisyChunks, { query: '리스크 관리 원칙을 한 문장으로 압축해줘', limit: 4 });
  assert.match(results[0].id, /^m[12]$/);
  const noisyIndex = results.findIndex((result) => result.id === 'n1');
  assert.ok(noisyIndex === -1 || results.findIndex((result) => /^m[12]$/.test(result.id)) < noisyIndex);
});

test('search demotes generic conversation logs for investment judgment questions', () => {
  const results = searchWikiChunks(noisyChunks, { query: '투자 판단에서 위키가 말하는 가장 조심해야 할 점은?', limit: 5 });
  assert.equal(results[0].id, 'm3');
  const genericLogIndex = results.findIndex((result) => result.id === 'n2');
  assert.ok(genericLogIndex === -1 || results.findIndex((result) => /^m[123]$/.test(result.id)) < genericLogIndex);
});
