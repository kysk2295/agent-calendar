const { sanitizeAgentReport, sanitizeSessionEvent, validateReport } = require('./agent-operations-domain');
const { deliverAgentReport } = require('./agent-report-delivery');
const { resolveRequestedOfficialProfile } = require('./official-profiles');
const {
  completedMissionEvidence,
  isRuntimeFailure,
  recordMissionBudget,
  schedulerId,
} = require('./agent-operations-scheduler-support');
const {
  blockExhaustedRevision,
  completeWorkResult,
  markCheckpointApplied,
  markQueuedExecutionApplied,
  prepareWorkExecution,
} = require('./agent-work-scheduler');

async function executeAgentTask({
  store,
  clock,
  executeCompletion,
  sendTelegram,
  task,
  result,
  onStarted = () => {},
} = {}) {
  const mission = store.getAgentMissions().find((item) => item.id === task.missionId);
  const session = store.getAgentSession(task.sessionId);
  if (!mission || !session) {
    store.updateTask(task.id, {
      status: 'failed',
      failureCode: 'task_contract_invalid',
      blockedReason: 'Agent task is missing its mission or Task Session',
      finishedAt: clock().toISOString(),
    });
    result.failedTaskIds.push(task.id);
    return false;
  }
  if (blockExhaustedRevision({ store, mission, task, session, result, clock })) return true;
  const startedAt = clock().toISOString();
  const runningTask = await store.claimAgentTask(task.id, {
    startedAt,
    blockedReason: '',
    failureCode: '',
    attempt: task.retryScheduledAt
      ? Math.max(1, Number(task.attempt || 1))
      : Number(task.attempt || 0) + 1,
    retryScheduledAt: '',
  });
  if (!runningTask) return false;
  recordMissionBudget(store, mission, task);
  store.updateAgentSession(session.id, { status: 'running' });
  store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
    kind: 'progress',
    text: `${runningTask.executionEngine || mission.executionEngine || 'hermes'} 실행 엔진에서 작업을 시작했습니다.`,
    metadata: {
      startedAt,
      attempt: runningTask.attempt,
      executionEngine: runningTask.executionEngine || mission.executionEngine || 'hermes',
    },
  }));
  result.startedTaskIds.push(task.id);
  onStarted(runningTask);
  try {
    const agentId = resolveRequestedOfficialProfile({
      agentId: task.createdByAgentId || mission.agentId,
      agent: task.agent,
    });
    const execution = prepareWorkExecution({
      store,
      mission,
      task,
      session,
      priorMissionEvidence: completedMissionEvidence(store, mission.id, session.id),
    });
    const completionPromise = executeCompletion({
      payload: {
        profile: agentId,
        executionEngine: task.executionEngine || mission.executionEngine || 'hermes',
        deliverable: task.deliverable || mission.deliverable || { kind: 'report', format: 'markdown' },
        stream: true,
        messages: execution.messages,
      },
      meta: {
        missionId: mission.id,
        taskId: task.id,
        sessionId: session.id,
        idempotencyKey: task.id,
        agentId,
        executionEngine: task.executionEngine || mission.executionEngine || 'hermes',
        deliverable: task.deliverable || mission.deliverable || { kind: 'report', format: 'markdown' },
      },
      onEvent: async (event) => {
        if (event.kind === 'agent_message') return;
        store.appendAgentSessionEvent(session.id, sanitizeSessionEvent(event));
      },
    });
    markQueuedExecutionApplied({ store, queuedEvents: execution.queuedEvents, clock });
    const completion = await completionPromise;
    const resolvedExecutionEngine = ['hermes', 'codex', 'claude', 'grok'].includes(String(completion?.executionEngine || '').trim())
      ? String(completion.executionEngine).trim()
      : '';
    const text = String(completion?.text || '').trim();
    if (!text) {
      const error = new Error('Hermes returned an empty task result');
      error.code = 'output_invalid';
      throw error;
    }
    const checkpointTask = store.getState().tasks.find((item) => item.id === task.id);
    if (checkpointTask.pauseRequestedAt || checkpointTask.cancelRequestedAt) {
      const cancelled = Boolean(checkpointTask.cancelRequestedAt);
      const status = cancelled ? 'cancelled' : 'blocked';
      store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
        kind: 'agent_message',
        text,
        metadata: { jobId: completion.jobId || '', applicationMode: 'checkpoint_result' },
      }));
      markCheckpointApplied({ store, taskId: task.id, action: cancelled ? 'cancel' : 'pause', clock });
      store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
        kind: 'artifact',
        text: task.expectedOutput || task.title,
        metadata: { checkpoint: true },
      }));
      store.updateTask(task.id, {
        status,
        blockedReason: cancelled ? '' : '사용자 일시정지 요청이 체크포인트에 적용됨',
        finishedAt: clock().toISOString(),
      });
      store.updateAgentSession(session.id, { status });
      store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
        kind: 'approval_response',
        text: `${cancelled ? 'cancel' : 'pause'} 요청을 checkpoint에 적용했습니다. 완료로 표시하지 않았습니다.`,
        metadata: { action: cancelled ? 'cancel' : 'pause', applicationMode: 'applied_at_checkpoint' },
      }));
      (cancelled ? result.cancelledTaskIds : result.blockedTaskIds).push(task.id);
      return true;
    }
    let report = null;
    if (task.actionClass === 'report') {
      try {
        report = sanitizeAgentReport(JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
        validateReport(report);
      } catch {
        const error = new Error('Hermes returned an invalid evidence-backed report');
        error.code = 'report_invalid';
        throw error;
      }
      const reportRecord = {
        ...report,
        id: schedulerId('agent-report', clock),
        missionId: mission.id,
        sessionId: session.id,
        taskId: task.id,
        status: 'ready',
        deliveryStatus: 'pending',
        ...(task.revisionId ? {
          revisionId: task.revisionId,
          revisionNumber: task.revisionNumber,
          revisesTaskId: task.revisesTaskId,
          revisesReportId: task.revisesReportId,
        } : {}),
        ...(resolvedExecutionEngine ? { resolvedExecutionEngine } : {}),
      };
      if (task.revisionId) {
        const now = clock().toISOString();
        report = { ...reportRecord, createdAt: now, updatedAt: now };
        const completedRevision = await completeWorkResult({ store, mission, task, session, report, clock });
        report = completedRevision?.report || report;
        result.createdReportIds.push(report.id);
      } else {
        report = store.createAgentReport(reportRecord);
        result.createdReportIds.push(report.id);
      }
    }
    store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
      kind: 'agent_message',
      text,
      metadata: {
        jobId: completion.jobId || '',
        requestedExecutionEngine: completion.requestedExecutionEngine || task.executionEngine || mission.executionEngine || 'hermes',
        executionEngine: completion.executionEngine || task.executionEngine || mission.executionEngine || 'hermes',
        ...(resolvedExecutionEngine ? { resolvedExecutionEngine } : {}),
      },
    }));
    store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
      kind: 'artifact',
      text: report ? report.title || task.title : task.expectedOutput || task.title,
      metadata: { reportId: report?.id || '', evidenceCount: report?.evidence?.length || 0 },
    }));
    store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
      kind: 'completion',
      text: '작업이 완료되어 결과와 근거를 저장했습니다.',
      metadata: {
        completedAt: clock().toISOString(),
        reportId: report?.id || '',
        executionEngine: completion.executionEngine || task.executionEngine || mission.executionEngine || 'hermes',
        ...(resolvedExecutionEngine ? { resolvedExecutionEngine } : {}),
      },
    }));
    store.updateTask(task.id, {
      status: 'completed',
      reportId: report?.id || '',
      finishedAt: clock().toISOString(),
      ...(resolvedExecutionEngine ? { resolvedExecutionEngine } : {}),
    });
    store.updateAgentSession(session.id, {
      status: 'completed',
      ...(resolvedExecutionEngine ? { resolvedExecutionEngine } : {}),
    });
    if (!task.revisionId) {
      await completeWorkResult({ store, mission, task, session, report, clock });
    }
    result.completedTaskIds.push(task.id);
    await deliverAgentReport({ store, sessionId: session.id, report, sendTelegram, clock });
  } catch (error) {
    const blocked = isRuntimeFailure(error);
    const status = blocked ? 'blocked' : 'failed';
    store.updateTask(task.id, {
      status,
      blockedReason: blocked ? error.message : '',
      failureCode: error.code || 'task_execution_failed',
      finishedAt: clock().toISOString(),
    });
    store.updateAgentSession(session.id, { status });
    store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
      kind: 'error',
      text: error.message || 'Agent task execution failed',
      metadata: { code: error.code || 'task_execution_failed', status },
    }));
    (blocked ? result.blockedTaskIds : result.failedTaskIds).push(task.id);
  }
  return true;
}

module.exports = { executeAgentTask };
