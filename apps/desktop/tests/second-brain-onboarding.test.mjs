import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const desktopRoot = new URL('../', import.meta.url);
const vite = await createServer({
  appType: 'custom', root: fileURLToPath(desktopRoot),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const model = await vite.ssrLoadModule('/src/features/second-brain/secondBrainModel.ts');
const clientModule = await vite.ssrLoadModule('/src/features/second-brain/secondBrainClient.ts');
const { SecondBrainOnboarding } = await vite.ssrLoadModule('/src/features/second-brain/SecondBrainOnboarding.tsx');

after(async () => { await vite.close(); });

test('run parser preserves backend truth and removes ungrounded claims', () => {
  const run = model.parseSecondBrainRun({
    id: 'run-1', status: 'ready_for_review', stage: 'ready_for_review', processed: 1, total: 1,
    sourceIds: ['file:f1'],
    snapshot: { id: 'snap-1', version: 1, status: 'ready_for_review', claims: [
      { id: 'grounded', text: '근거 있음', provenance: { sourceId: 'file:f1' }, citation: 'notes.md:1' },
      { id: 'hidden', text: '근거 없음' },
    ] },
  });
  assert.equal(run.processed, 1);
  assert.deepEqual(run.snapshot.claims.map((claim) => claim.id), ['grounded']);
});

test('client calls current, run, and review public seams', async () => {
  const calls = [];
  const client = clientModule.createSecondBrainClient({
    getConnection: async () => ({ baseUrl: 'https://gateway.test', credential: 'proxy' }),
    fetcher: async (url, init = {}) => {
      calls.push([String(url), init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
      const body = String(url).endsWith('/current')
        ? { run: null, snapshot: null }
        : String(url).includes('/review')
          ? { snapshot: { id: 's2', version: 2, status: 'active', claims: [] } }
          : { run: { id: 'r1', status: 'source_required', stage: 'source_required', processed: 0, total: 0, sourceIds: [] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.getCurrent();
  await client.startRun('idem-1');
  await client.reviewSnapshot('s1', [{ claimId: 'c1', action: 'confirm', basis: '검토함' }], true);
  assert.deepEqual(calls.map(([url, method]) => [new URL(url).pathname, method]), [
    ['/api/second-brain/current', 'GET'],
    ['/api/second-brain/runs', 'POST'],
    ['/api/second-brain/snapshots/s1/review', 'POST'],
  ]);
});

test('Desktop polls persisted run truth and surfaces each observed server checkpoint', async () => {
  const stages = ['indexing', 'extracting', 'linking', 'ready_for_review'];
  const observed = [];
  const terminal = await clientModule.pollSecondBrainRun({
    async getRun() {
      const stage = stages.shift();
      return {
        id: 'r1',
        status: stage === 'ready_for_review' ? 'ready_for_review' : 'running',
        stage,
        processed: stage === 'indexing' ? 0 : 1,
        total: 1,
        sourceIds: ['file:f1'],
        snapshot: stage === 'ready_for_review'
          ? { id: 's1', version: 1, status: 'ready_for_review', claims: [] }
          : null,
        error: null,
      };
    },
  }, 'r1', {
    wait: async () => {},
    onUpdate: (run) => observed.push([run.stage, run.processed, run.total]),
  });
  assert.equal(terminal.status, 'ready_for_review');
  assert.deepEqual(observed, [
    ['indexing', 0, 1],
    ['extracting', 1, 1],
    ['linking', 1, 1],
    ['ready_for_review', 1, 1],
  ]);
});

test('typing after selecting correction updates the exact decision submitted to review', () => {
  const selected = model.stageSecondBrainDecision({}, 'claim-1', 'correct', '기존 문장');
  const typed = model.updateStagedCorrection(selected, 'claim-1', '사용자가 입력한 수정 문장');
  assert.deepEqual(Object.values(typed), [{
    claimId: 'claim-1',
    action: 'correct',
    text: '사용자가 입력한 수정 문장',
    basis: '사용자 수정',
  }]);
});

test('review surface offers confirm, correct, and reject with citations', () => {
  const html = renderToStaticMarkup(createElement(SecondBrainOnboarding, {
    run: model.parseSecondBrainRun({
      id: 'run-1', status: 'ready_for_review', stage: 'ready_for_review', processed: 1, total: 1,
      sourceIds: ['file:f1'], snapshot: { id: 's1', version: 1, status: 'ready_for_review', claims: [
        { id: 'c1', text: '매주 검토', provenance: { sourceId: 'file:f1' }, citation: 'notes.md:1' },
      ] },
    }),
    sourceAvailable: true, onStart: async () => {}, onReview: async () => {},
    onConnectCalendar: async () => {}, onOpenWiki: () => {},
  }));
  assert.match(html, /notes\.md:1/);
  assert.match(html, />확인</);
  assert.match(html, />수정</);
  assert.match(html, />제외</);
  assert.match(html, /검토 완료 및 활성화/);
});
