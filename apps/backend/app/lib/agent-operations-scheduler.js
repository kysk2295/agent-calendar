const { sanitizeAgentReport, sanitizeSessionEvent, validateReport } = require('./agent-operations-domain');
const { taskExecutionMessages } = require('./agent-operations-execution');
const { deliverAgentReport } = require('./agent-report-delivery');
const {
  completedMissionEvidence,
  createSchedulerResult,
  isRuntimeFailure,
  recordMissionBudget,
  schedulerId,
} = require('./agent-operations-scheduler-support');

class AgentOperationsScheduler {
  constructor({
    store,
    clock = () => new Date(),
    executeCompletion,
    sendTelegram = null,
  } = {}) {
    if (!store) throw new Error('AgentOperationsScheduler requires a store');
    if (typeof executeCompletion !== 'function') {
      throw new Error('AgentOperationsScheduler requires executeCompletion');
    }
    this.store = store;
    this.clock = clock;
    this.executeCompletion = executeCompletion;
    this.sendTelegram = sendTelegram;
    this.tickPromise = null;
  }

  async tick() {
    if (this.tickPromise) {
      return createSchedulerResult(this.clock().toISOString(), {
        skipped: true,
        reason: 'scheduler tick already running',
      });
    }
    this.tickPromise = this.#tickOnce();
    try {
      return await this.tickPromise;
    } finally {
      this.tickPromise = null;
    }
  }

  async #tickOnce() {
    const checkedAt = this.clock().toISOString();
    const result = createSchedulerResult(checkedAt);
    const state = this.store.getState();
    const activeMissionIds = new Set(
      state.agentMissions
        .filter((mission) => mission.status === 'active')
        .map((mission) => mission.id),
    );
    const dueTasks = state.tasks
      .filter((task) => (
        task.origin === 'agent'
        && task.status === 'scheduled'
        && activeMissionIds.has(task.missionId)
        && Number.isFinite(new Date(task.scheduledAt).getTime())
        && new Date(task.scheduledAt).getTime() <= new Date(checkedAt).getTime()
      ))
      .sort((left, right) => (
        String(left.scheduledAt).localeCompare(String(right.scheduledAt))
        || String(left.id).localeCompare(String(right.id))
      ));

    for (const task of dueTasks) {
      const currentTask = this.store.getState().tasks.find((item) => item.id === task.id);
      if (currentTask?.status === 'scheduled') {
        const executed = await this.#executeTask(currentTask, result);
        if (executed) break;
      }
    }
    return result;
  }

  async #executeTask(task, result) {
    const mission = this.store.getAgentMissions().find((item) => item.id === task.missionId);
    const session = this.store.getAgentSession(task.sessionId);
    if (!mission || !session) {
      this.store.updateTask(task.id, {
        status: 'failed',
        failureCode: 'task_contract_invalid',
        blockedReason: 'Agent task is missing its mission or Task Session',
        finishedAt: this.clock().toISOString(),
      });
      result.failedTaskIds.push(task.id);
      return false;
    }

    const startedAt = this.clock().toISOString();
    const runningTask = await this.store.claimAgentTask(task.id, {
      startedAt,
      blockedReason: '',
      failureCode: '',
      attempt: task.retryScheduledAt
        ? Math.max(1, Number(task.attempt || 1))
        : Number(task.attempt || 0) + 1,
      retryScheduledAt: '',
    });
    if (!runningTask) return false;
    this.store.updateAgentSession(session.id, { status: 'running' });
    this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
      kind: 'progress',
      text: 'Mac mini Hermes에서 작업을 시작했습니다.',
      metadata: { startedAt, attempt: runningTask.attempt },
    }));
    result.startedTaskIds.push(task.id);

    try {
      const agentId = task.createdByAgentId || task.agent || mission.agentId;
      const completion = await this.executeCompletion({
        payload: {
          profile: agentId,
          stream: true,
          messages: taskExecutionMessages(
            mission,
            task,
            this.store.getAgentSession(session.id),
            completedMissionEvidence(this.store, mission.id, session.id),
          ),
        },
        meta: {
          missionId: mission.id,
          taskId: task.id,
          sessionId: session.id,
          idempotencyKey: task.id,
          agentId,
        },
        onEvent: async (event) => {
          if (event.kind === 'agent_message') return;
          this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent(event));
        },
      });
      const text = String(completion?.text || '').trim();
      if (!text) {
        const error = new Error('Hermes returned an empty task result');
        error.code = 'output_invalid';
        throw error;
      }

      const checkpointTask = this.store.getState().tasks.find((item) => item.id === task.id);
      if (checkpointTask.pauseRequestedAt || checkpointTask.cancelRequestedAt) {
        const cancelled = Boolean(checkpointTask.cancelRequestedAt);
        const status = cancelled ? 'cancelled' : 'blocked';
        this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
          kind: 'agent_message',
          text,
          metadata: { jobId: completion.jobId || '', applicationMode: 'checkpoint_result' },
        }));
        this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
          kind: 'artifact',
          text: task.expectedOutput || task.title,
          metadata: { checkpoint: true },
        }));
        this.store.updateTask(task.id, {
          status,
          blockedReason: cancelled ? '' : '사용자 일시정지 요청이 체크포인트에 적용됨',
          finishedAt: this.clock().toISOString(),
        });
        this.store.updateAgentSession(session.id, { status });
        this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
          kind: 'approval_response',
          text: `${cancelled ? 'cancel' : 'pause'} 요청을 checkpoint에 적용했습니다. 완료로 표시하지 않았습니다.`,
          metadata: { action: cancelled ? 'cancel' : 'pause', applicationMode: 'applied_at_checkpoint' },
        }));
        (cancelled ? result.cancelledTaskIds : result.blockedTaskIds).push(task.id);
        return true;
      }

      let report = null;
      if (task.actionClass === 'report') {
        let parsed;
        try {
          parsed = sanitizeAgentReport(JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
          validateReport(parsed);
        } catch {
          const error = new Error('Hermes returned an invalid evidence-backed report');
          error.code = 'report_invalid';
          throw error;
        }
        report = this.store.createAgentReport({
          ...parsed,
          id: schedulerId('agent-report', this.clock),
          missionId: mission.id,
          sessionId: session.id,
          taskId: task.id,
          status: 'ready',
          deliveryStatus: 'pending',
        });
        result.createdReportIds.push(report.id);
      }

      this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
        kind: 'agent_message',
        text,
        metadata: { jobId: completion.jobId || '' },
      }));
      this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
        kind: 'artifact',
        text: report ? report.title || task.title : task.expectedOutput || task.title,
        metadata: {
          reportId: report?.id || '',
          evidenceCount: report?.evidence?.length || 0,
        },
      }));
      this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
        kind: 'completion',
        text: '작업이 완료되어 결과와 근거를 저장했습니다.',
        metadata: { completedAt: this.clock().toISOString(), reportId: report?.id || '' },
      }));
      this.store.updateTask(task.id, {
        status: 'completed',
        reportId: report?.id || '',
        finishedAt: this.clock().toISOString(),
      });
      this.store.updateAgentSession(session.id, { status: 'completed' });
      recordMissionBudget(this.store, mission, task);
      result.completedTaskIds.push(task.id);
      await deliverAgentReport({
        store: this.store,
        sessionId: session.id,
        report,
        sendTelegram: this.sendTelegram,
        clock: this.clock,
      });
    } catch (error) {
      const blocked = isRuntimeFailure(error);
      const status = blocked ? 'blocked' : 'failed';
      this.store.updateTask(task.id, {
        status,
        blockedReason: blocked ? error.message : '',
        failureCode: error.code || 'task_execution_failed',
        finishedAt: this.clock().toISOString(),
      });
      this.store.updateAgentSession(session.id, { status });
      this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
        kind: 'error',
        text: error.message || 'Agent task execution failed',
        metadata: { code: error.code || 'task_execution_failed', status },
      }));
      (blocked ? result.blockedTaskIds : result.failedTaskIds).push(task.id);
    }
    return true;
  }

}

module.exports = {
  AgentOperationsScheduler,
};
