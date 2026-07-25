'use strict';

const crypto = require('node:crypto');
const { resolveEngine } = require('./durable-execution');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptFromMessages(messages, purpose = 'calendar_ai') {
  const transcript = messages
    .slice(-16)
    .map((message) => `${String(message.role || 'user').toUpperCase()}: ${String(message.content || '')}`)
    .join('\n\n');
  return [
    purpose === 'wiki_ai'
      ? 'Agent Calendar의 Wiki AI로서 제공된 Workspace 근거에만 기반해 자연스러운 한국어 답변을 작성하세요.'
      : 'Agent Calendar의 Calendar AI로서 다음 대화에 자연스러운 한국어 답변만 작성하세요.',
    '도구를 실행하거나 일정 변경을 완료했다고 주장하지 마세요.',
    transcript,
  ].join('\n\n').slice(0, 4000);
}

function createRunnerWorkspaceInferenceCompletion({
  pool,
  durableExecution,
  env = process.env,
} = {}) {
  if (!pool || !durableExecution) return null;
  return async function runnerComplete({
    messages = [],
    scope,
    requestId = '',
    conversationId = '',
    purpose = 'calendar_ai',
    runner: selectedRunner = null,
    engine = '',
    requestedEngine = '',
  } = {}) {
    if (!scope) {
      const error = new Error('Workspace scope is required for Runner inference');
      error.code = 'WORKSPACE_SCOPE_REQUIRED';
      throw error;
    }
    const requested = String(requestedEngine || engine || 'auto').toLowerCase();
    const runner = selectedRunner || await withAppRoleWorkspaceTransaction(
      pool,
      scope,
      async (client, valid) => {
        const rows = await client.query(
          `select id, capabilities
           from runners
           where workspace_id = $1
             and status = 'active'
             and connection_state = 'connected'
           order by last_seen_at desc nulls last`,
          [valid.workspaceId],
        );
        return rows.rows.find((row) => resolveEngine(requested, row.capabilities).resolved) || null;
      },
    );
    if (!runner) {
      const error = new Error('Workspace Runner inference is unavailable');
      error.code = 'INFERENCE_RUNNER_UNAVAILABLE';
      throw error;
    }

    const requestKey = String(requestId || crypto.randomUUID());
    const missionId = `mission_inference_${crypto
      .createHash('sha256')
      .update(`${scope.workspaceId}:${purpose}:${requestKey}`)
      .digest('hex')
      .slice(0, 20)}`;
    const work = await durableExecution.acceptWork(scope, {
      missionId,
      title: purpose === 'wiki_ai' ? 'Wiki AI 답변 합성' : 'Calendar AI 대화',
      goal: promptFromMessages(messages, purpose),
      agentId: purpose === 'wiki_ai' ? 'wiki-ai' : 'calendar-ai',
      executionEngine: engine || requested,
      preferredRunnerId: runner.id,
      clientRequestId: `workspace-inference:${purpose}:${requestKey}`,
      templateId: 'workspace-inference',
      payload: {
        kind: 'workspace_inference',
        purpose,
        calendarAiConversationId: String(conversationId || ''),
        inferenceRequestId: requestKey,
      },
    });
    if (work.waitingRunner) {
      const error = new Error('Workspace Runner became unavailable');
      error.code = String(work.engineReason || '').startsWith('engine_auth_required:')
        ? 'ENGINE_AUTH_REQUIRED'
        : 'RUNNER_OFFLINE';
      throw error;
    }

    const waitMs = Math.max(1_000, Number(
      env.WORKSPACE_INFERENCE_RUNNER_WAIT_MS
      || env.CALENDAR_AI_RUNNER_WAIT_MS
      || 25_000,
    ));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const state = await withAppRoleWorkspaceTransaction(pool, scope, async (client, valid) => {
        const job = await client.query(
          `select j.status, j.resolved_engine, m.payload as mission_payload
           from execution_jobs j
           inner join agent_missions m
             on m.workspace_id = j.workspace_id and m.id = j.mission_id
           where j.workspace_id = $1 and j.id = $2
           limit 1`,
          [valid.workspaceId, work.jobId],
        );
        if (!job.rowCount) return null;
        const artifact = await client.query(
          `select content from execution_artifacts
           where workspace_id = $1 and job_id = $2
             and content_type like 'text/%'
           order by created_at desc
           limit 1`,
          [valid.workspaceId, work.jobId],
        );
        return {
          ...job.rows[0],
          artifact: artifact.rowCount ? String(artifact.rows[0].content || '') : '',
        };
      });
      if (!state) {
        const error = new Error('Workspace Runner inference job disappeared');
        error.code = 'INFERENCE_RUNNER_FAILED';
        throw error;
      }
      if (state.status === 'completed') {
        const missionPayload = state.mission_payload
          && typeof state.mission_payload === 'object'
          && !Array.isArray(state.mission_payload)
          ? state.mission_payload
          : {};
        const text = String(state.artifact || missionPayload.resultSummary || '').trim();
        if (text) {
          return { text, engine: String(state.resolved_engine || engine || requested) };
        }
        await pause(100);
        continue;
      }
      if (['failed', 'dead_letter', 'cancelled'].includes(state.status)) {
        const error = new Error(`Workspace Runner inference ${state.status}`);
        error.code = state.status === 'cancelled'
          ? 'INFERENCE_RUNNER_CANCELLED'
          : 'INFERENCE_RUNNER_FAILED';
        throw error;
      }
      await pause(250);
    }
    const error = new Error('Workspace Runner inference timed out');
    error.code = 'INFERENCE_RUNNER_TIMEOUT';
    throw error;
  };
}

function createRunnerCalendarAiCompletion(options = {}) {
  return createRunnerWorkspaceInferenceCompletion(options);
}

module.exports = {
  createRunnerCalendarAiCompletion,
  createRunnerWorkspaceInferenceCompletion,
  promptFromMessages,
};
