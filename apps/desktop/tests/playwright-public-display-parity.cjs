'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  projectPublicDisplayEvent,
  publicDisplayDelivery,
  publicDisplayTuple,
} = require('../../backend/app/lib/public-work-conversation-event');

const target = process.env.HERMES_UI_URL;
if (!target) throw new Error('HERMES_UI_URL is required; run through run-playwright-with-vite.cjs');

const createdAt = '2026-07-26T00:00:00.000Z';
const rawEvents = [
  {
    id: 'evt_user',
    sequence: 1,
    kind: 'user_message',
    payload: { text: 'Continue from Telegram', origin: 'telegram', token: 'private' },
    created_at: createdAt,
  },
  {
    id: 'evt_progress',
    sequence: 2,
    kind: 'progress',
    payload: { text: 'private runner progress', origin: 'execution' },
    created_at: '2026-07-26T00:00:01.000Z',
  },
  {
    id: 'evt_result',
    sequence: 5,
    kind: 'completion',
    payload: {
      text: 'Current Calendar result password=hunter2',
      origin: 'execution',
      metadata: { resolvedExecutionEngine: 'codex' },
    },
    created_at: '2026-07-26T00:00:04.000Z',
  },
  {
    id: 'evt_approval',
    sequence: 6,
    kind: 'approval_request',
    payload: { text: 'Approve the supported calendar change?', origin: 'agent' },
    created_at: '2026-07-26T00:00:05.000Z',
  },
  {
    id: 'evt_error',
    sequence: 7,
    kind: 'error',
    payload: {
      text: 'Calendar update failed: token=private',
      origin: 'calendar',
      metadata: { code: 'calendar_update_failed' },
    },
    created_at: '2026-07-26T00:00:06.000Z',
  },
];
const serverProjection = rawEvents
  .map((event) => projectPublicDisplayEvent(event, { sessionId: 'session_public_parity' }))
  .filter(Boolean);
const response = {
  ok: true,
  work: {
    id: 'mission_public_parity',
    templateId: 'general-agent-work',
    title: 'Public parity',
    objective: 'Compare the exact public display',
    status: 'active',
    agentId: 'default',
    assignmentReason: 'default:official',
    executionEngine: 'auto',
    activeExecutionEngine: 'codex',
    activeExecutionModel: '',
    resolvedExecutionModel: '',
    deliverable: { kind: 'file', format: 'auto' },
    missionThreadId: 'session_public_parity',
    workConversationId: 'session_public_parity',
    revisionCounter: 0,
    createdAt,
    updatedAt: createdAt,
  },
  conversation: {
    id: 'session_public_parity',
    missionId: 'mission_public_parity',
    type: 'mission-thread',
    title: 'Public parity',
    status: 'planning',
    pendingInstructions: [],
    executionEngine: 'auto',
    deliverable: { kind: 'file', format: 'auto' },
    createdAt,
    updatedAt: createdAt,
  },
  checkpoints: serverProjection,
  channels: [],
  nextCursor: null,
};
const telegramTuples = serverProjection
  .map(publicDisplayDelivery)
  .map(publicDisplayTuple);

async function main() {
  const evidenceDir = path.resolve(
    process.env.PLAYWRIGHT_VITE_EVIDENCE_DIR || '.omo/evidence/production-readiness-completion/task-7',
  );
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    const desktop = await page.evaluate(async (serverResponse) => {
      const reactModule = await import('/@id/react');
      const React = reactModule.default || reactModule;
      const reactDomClient = await import('/@id/react-dom/client');
      const createRoot = reactDomClient.createRoot || reactDomClient.default?.createRoot;
      const { parseAgentWorkConversationPage } = await import(
        '/src/features/agent-operations/workConversationParser.ts'
      );
      const { AgentWorkTimeline } = await import(
        '/src/features/agent-operations/AgentWorkTimeline.tsx'
      );
      const parsed = parseAgentWorkConversationPage(serverResponse);
      const mount = document.createElement('div');
      mount.id = 'public-parity-surface';
      document.body.replaceChildren(mount);
      createRoot(mount).render(React.createElement(AgentWorkTimeline, {
        checkpoints: parsed.checkpoints,
        loading: false,
        error: '',
        readOnly: true,
        tasks: [],
        reports: [],
        currentResultReportId: '',
        responsibleAgentName: 'Responsible Agent',
        busy: '',
        onTaskAction: async () => false,
        onOpenSession: () => {},
        onReportFeedback: async () => {},
        onFollowUpDecision: async () => {},
        onRefresh: async () => {},
        onRetry: async () => {},
        liveTurn: { active: false, text: '', error: '' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const tuple = (checkpoint) => [
        checkpoint.sequence,
        checkpoint.kind,
        checkpoint.text,
        checkpoint.origin,
      ];
      const renderedTuples = Array.from(
        document.querySelectorAll('#public-parity-surface article.agent-checkpoint[data-sequence]'),
      ).map((article) => [
        Number(article.getAttribute('data-sequence')),
        article.getAttribute('data-kind'),
        article.querySelector(':scope > p')?.textContent || '',
        article.getAttribute('data-origin'),
      ]);
      return {
        parsedTuples: parsed.checkpoints.map(tuple),
        renderedTuples,
      };
    }, response);
    const serverTuples = serverProjection.map(publicDisplayTuple);
    assert.deepEqual(desktop.parsedTuples, serverTuples);
    assert.deepEqual(desktop.renderedTuples, serverTuples);
    assert.deepEqual(telegramTuples, serverTuples);
    assert.doesNotMatch(
      JSON.stringify({ ...desktop, telegramTuples, serverTuples }),
      /hunter2|credential|private runner progress|raw tool/i,
    );
    await page.screenshot({
      path: path.join(evidenceDir, 'desktop-public-display-parity.png'),
      fullPage: true,
    });
    fs.writeFileSync(
      path.join(evidenceDir, 'public-display-tuples.json'),
      `${JSON.stringify({
        ok: true,
        serverTuples,
        desktopParsedTuples: desktop.parsedTuples,
        desktopRenderedTuples: desktop.renderedTuples,
        telegramTuples,
      }, null, 2)}\n`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
