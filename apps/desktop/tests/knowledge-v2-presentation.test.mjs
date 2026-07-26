import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';

const vite = await createViteServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'silent',
});
test.after(async () => {
  await vite.close();
});

const presentation = await vite.ssrLoadModule('/src/domains/knowledge/knowledgeV2.ts');

test('Knowledge v2 answer parser keeps opaque citations and truthful pending state', () => {
  const ready = presentation.parseKnowledgeV2Answer({
    answer: '근거가 있는 답변',
    answerStatus: 'ok',
    mode: 'knowledge_v2',
    citations: [{
      handle: 'h_safe',
      title: '정본',
      excerpt: '근거 요약',
      sourceId: 'ksrc_a',
    }],
  });
  assert.equal(ready.answer, '근거가 있는 답변');
  assert.deepEqual(ready.sources, [{
    handle: 'h_safe',
    title: '정본',
    excerpt: '근거 요약',
    sourceId: 'ksrc_a',
  }]);
  assert.equal(ready.meta.answerStatus, 'ok');
  assert.equal(ready.meta.provider, 'Knowledge v2');

  const pending = presentation.parseKnowledgeV2Answer({
    answer: 'Knowledge search is pending on a Workspace Runner.',
    answerStatus: 'pending',
    code: 'KNOWLEDGE_SEARCH_PENDING',
    jobId: 'job_1',
    privateLocal: { status: 'pending' },
  });
  assert.equal(pending.jobId, 'job_1');
  assert.equal(pending.answer, 'Runner에서 로컬 지식을 검색하고 있습니다.');
  assert.equal(pending.meta.answerStatus, 'pending');
  assert.equal(pending.meta.privateLocalStatus, 'pending');

  const empty = presentation.parseKnowledgeV2Answer({
    answer: 'No workspace knowledge passages matched this question.',
    answerStatus: 'empty',
  });
  assert.equal(empty.answer, '현재 Workspace 지식에서 답을 찾지 못했습니다.');
});

test('Knowledge job result becomes an answer without inventing file paths', () => {
  const completed = presentation.parseKnowledgeV2Job({
    status: 'completed',
    jobId: 'job_1',
    results: [{
      handle: 'h_result',
      title: '로컬 메모',
      excerpt: '오늘 할 일은 배포 점검이다.',
      sourceId: 'ksrc_local',
    }],
  });
  assert.match(completed.answer, /배포 점검/);
  assert.equal(completed.sources[0].handle, 'h_result');
  assert.equal('path' in completed.sources[0], false);
  assert.equal(completed.meta.answerStatus, 'ok');
});

test('Knowledge source presentation distinguishes ready, runner-required, revoked, and error', () => {
  assert.equal(presentation.knowledgeSourceStatusLabel({ status: 'ready' }), '사용 가능');
  assert.equal(
    presentation.knowledgeSourceStatusLabel({ status: 'runner_required', sourceKind: 'private_local' }),
    'Runner 연결 필요',
  );
  assert.equal(presentation.knowledgeSourceStatusLabel({ status: 'revoked' }), '연결 해제됨');
  assert.equal(presentation.knowledgeSourceStatusLabel({ status: 'error' }), '오류');
  assert.equal(presentation.knowledgeSourceKindLabel({ sourceKind: 'cloud_indexed' }), '암호화 색인');
  assert.equal(presentation.knowledgeSourceKindLabel({ sourceKind: 'private_local' }), 'Runner 로컬');
});
