'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');

const {
  archiveCompletedDelegatedWork,
  buildDelegatedWorkArchiveMarkdown,
  proposeAgentMemoryPins,
  shouldArchiveCompletedMission,
  writeDelegatedWorkArchive,
} = require('../app/lib/agent-work-wiki-archive');
const { terminalizeAgentMission } = require('../app/lib/agent-operations-scheduler-support');
const { HermesStore } = require('../app/lib/store');
const { publicMissionRecord } = require('../app/lib/public-agent-records');

const FIXED_NOW = new Date('2026-07-31T09:00:00.000Z');

function createMissionFixture(store, {
  status = 'completed',
  withReport = true,
  missionId = 'mission-archive-1',
  reportId = 'report-archive-1',
  threadId = 'thread-archive-1',
} = {}) {
  const mission = store.createAgentMission({
    id: missionId,
    title: '주간 기회 브리프',
    objective: '금요일 전까지 경쟁 기회 3개를 검증한다.',
    status,
    agentId: 'business-consultant',
    missionThreadId: threadId,
    currentResultReportId: withReport ? reportId : '',
    completedAt: status === 'completed' ? FIXED_NOW.toISOString() : undefined,
  });
  store.createAgentSession({
    id: threadId,
    missionId,
    type: 'mission-thread',
    title: 'Work Conversation',
    status: 'active',
  });
  store.createTask({
    id: 'task-archive-research',
    missionId,
    origin: 'agent',
    title: '경쟁사 변화 수집',
    status: 'completed',
    actionClass: 'research',
  });
  store.createTask({
    id: 'task-archive-report',
    missionId,
    origin: 'agent',
    title: '결과 보고',
    status: 'completed',
    actionClass: 'report',
    reportId: withReport ? reportId : '',
  });
  if (withReport) {
    store.createAgentReport({
      id: reportId,
      missionId,
      status: 'ready',
      title: '주간 기회 3건',
      findings: [
        'A사는 가격을 8% 인하했다.',
        'B사는 신규 플랜을 공개했다.',
        'token=supersecret should be redacted',
      ],
      limitations: ['공개 웹 자료만 사용'],
      followUps: [{ title: '가격 인하 영향 재검증', reason: '근거 보강' }],
    });
  }
  return mission;
}

test('buildDelegatedWorkArchiveMarkdown includes goal findings and tasks without absolute secrets', () => {
  const markdown = buildDelegatedWorkArchiveMarkdown({
    mission: {
      id: 'mission-1',
      title: '주간 기회 브리프',
      objective: '경쟁 기회 검증',
      status: 'completed',
      agentId: 'business-consultant',
    },
    report: {
      id: 'report-1',
      title: '결과',
      findings: ['기회 1', '/Users/koyunseo/private.md'],
      limitations: ['제한'],
      followUps: [{ title: '후속' }],
    },
    tasks: [
      { title: '조사', status: 'completed', actionClass: 'research' },
      { title: '보고', status: 'completed', actionClass: 'report' },
    ],
    now: FIXED_NOW,
  });

  assert.match(markdown, /type: delegated-work-archive/);
  assert.match(markdown, /# 주간 기회 브리프/);
  assert.match(markdown, /경쟁 기회 검증/);
  assert.match(markdown, /기회 1/);
  assert.match(markdown, /\[completed\] 조사 \(research\)/);
  assert.doesNotMatch(markdown, /\/Users\/koyunseo/);
  assert.match(markdown, /PRIVATE_PATH|redacted|private-path|\[REDACTED\]/i);
});

test('proposeAgentMemoryPins returns short unique candidates from findings', () => {
  const pins = proposeAgentMemoryPins({
    mission: { objective: '목표 문구' },
    report: {
      findings: [
        'A사는 가격을 8% 인하했다.',
        'A사는 가격을 8% 인하했다.',
        'B사는 신규 플랜을 공개했다.',
        'C사는 파트너십을 발표했다.',
        'D사는 무시',
      ],
    },
  });
  assert.equal(pins.length, 3);
  assert.equal(pins[0], 'A사는 가격을 8% 인하했다.');
  assert.equal(new Set(pins).size, 3);
});

test('writeDelegatedWorkArchive writes under agent-runs when wiki root is set', async () => {
  const wikiRoot = await mkdtemp(path.join(os.tmpdir(), 'delegated-work-wiki-'));
  try {
    const result = writeDelegatedWorkArchive({
      wikiRoot,
      mission: {
        id: 'mission-write-1',
        title: '보관 테스트',
        objective: '목표',
        status: 'completed',
        agentId: 'business-consultant',
      },
      report: {
        id: 'report-write-1',
        title: '결과',
        findings: ['핵심 사실'],
      },
      tasks: [{ title: '보고', status: 'completed', actionClass: 'report' }],
      now: FIXED_NOW,
    });

    assert.equal(result.status, 'written');
    assert.match(result.relativePath, /^5_conversation\/agent-runs\//);
    const absolute = path.join(wikiRoot, result.relativePath);
    assert.equal(fs.existsSync(absolute), true);
    const body = await readFile(absolute, 'utf8');
    assert.match(body, /핵심 사실/);
    const log = await readFile(path.join(wikiRoot, 'log.md'), 'utf8');
    assert.match(log, /delegated-work-archive/);
  } finally {
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test('writeDelegatedWorkArchive skips honestly when wiki root is missing', () => {
  const result = writeDelegatedWorkArchive({
    wikiRoot: '',
    mission: { id: 'mission-skip', title: '스킵', status: 'completed' },
    report: { id: 'report-skip', findings: ['사실'] },
    now: FIXED_NOW,
  });
  assert.equal(result.status, 'skipped_no_wiki');
  assert.equal(result.relativePath, '');
  assert.ok(result.proposedMemoryPins.length >= 1);
});

test('shouldArchiveCompletedMission is idempotent for same report', () => {
  assert.equal(shouldArchiveCompletedMission({
    status: 'completed',
    wikiArchive: { status: 'written', reportId: 'report-1' },
  }, { id: 'report-1', status: 'ready' }), false);

  assert.equal(shouldArchiveCompletedMission({
    status: 'completed',
    wikiArchive: { status: 'written', reportId: 'report-old' },
  }, { id: 'report-new', status: 'ready' }), true);
});

test('archiveCompletedDelegatedWork updates mission and appends conversation artifact', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'delegated-work-store-'));
  const wikiRoot = await mkdtemp(path.join(os.tmpdir(), 'delegated-work-wiki-'));
  try {
    const store = new HermesStore({ dataDir });
    createMissionFixture(store);

    const result = archiveCompletedDelegatedWork({
      store,
      missionId: 'mission-archive-1',
      wikiRoot,
      clock: () => FIXED_NOW,
    });

    assert.equal(result.wikiArchive.status, 'written');
    const mission = store.getAgentMissions().find((item) => item.id === 'mission-archive-1');
    assert.equal(mission.wikiArchive.status, 'written');
    assert.ok(mission.wikiArchive.relativePath);
    assert.equal(mission.proposedMemoryPins.length >= 1, true);

    const thread = store.getAgentSession('thread-archive-1');
    const artifact = thread.events.find((event) => (
      event.kind === 'artifact' && event.metadata?.wikiArchiveStatus === 'written'
    ));
    assert.ok(artifact);
    assert.match(artifact.text, /위키/);
    assert.equal(artifact.metadata.wikiArchiveNote, mission.wikiArchive.relativePath);

    const again = archiveCompletedDelegatedWork({
      store,
      missionId: 'mission-archive-1',
      wikiRoot,
      clock: () => FIXED_NOW,
    });
    assert.equal(again.status, 'written');
    const eventsAfter = store.getAgentSession('thread-archive-1').events
      .filter((event) => event.metadata?.wikiArchiveStatus === 'written');
    assert.equal(eventsAfter.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test('terminalizeAgentMission archives completed work when wikiRoot provided', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'terminalize-wiki-'));
  const wikiRoot = await mkdtemp(path.join(os.tmpdir(), 'terminalize-wiki-root-'));
  try {
    const store = new HermesStore({ dataDir });
    // active mission with all tasks completed + ready report
    store.createAgentMission({
      id: 'mission-term-1',
      title: '터미널 보관',
      objective: '목표',
      status: 'active',
      agentId: 'business-consultant',
      missionThreadId: 'thread-term-1',
      currentResultReportId: 'report-term-1',
    });
    store.createAgentSession({
      id: 'thread-term-1',
      missionId: 'mission-term-1',
      type: 'mission-thread',
      title: 'Work Conversation',
      status: 'active',
    });
    store.createTask({
      id: 'task-term-1',
      missionId: 'mission-term-1',
      origin: 'agent',
      title: '보고',
      status: 'completed',
      actionClass: 'report',
      reportId: 'report-term-1',
    });
    store.createAgentReport({
      id: 'report-term-1',
      missionId: 'mission-term-1',
      status: 'ready',
      title: '결과',
      findings: ['완료 사실'],
    });

    const updated = terminalizeAgentMission({
      store,
      missionId: 'mission-term-1',
      clock: () => FIXED_NOW,
      wikiRoot,
    });

    assert.equal(updated.status, 'completed');
    assert.equal(updated.wikiArchive?.status, 'written');
    assert.ok(fs.existsSync(path.join(wikiRoot, updated.wikiArchive.relativePath)));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test('publicMissionRecord exposes safe wikiArchive and memory pin count only', () => {
  const projected = publicMissionRecord({
    id: 'mission-public-1',
    title: '공개 미션',
    status: 'completed',
    agentId: 'business-consultant',
    wikiArchive: {
      status: 'written',
      relativePath: '5_conversation/agent-runs/2026-07-31-note.md',
      archivedAt: FIXED_NOW.toISOString(),
      reportId: 'report-public-1',
      absolutePath: '/Users/koyunseo/secret/wiki/note.md',
    },
    proposedMemoryPins: ['핀 1', '핀 2'],
  });

  assert.equal(projected.wikiArchive.status, 'written');
  assert.equal(projected.wikiArchive.relativePath, '5_conversation/agent-runs/2026-07-31-note.md');
  assert.equal(projected.wikiArchive.archivedAt, FIXED_NOW.toISOString());
  assert.equal(Object.hasOwn(projected.wikiArchive, 'absolutePath'), false);
  assert.equal(projected.proposedMemoryPinCount, 2);
  assert.deepEqual(projected.proposedMemoryPins, ['핀 1', '핀 2']);
});
