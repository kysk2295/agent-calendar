const crypto = require('node:crypto');

const { sanitizeSessionEvent, validateReport } = require('./agent-operations-domain');

function schedulerId(prefix, clock) {
  const stamp = clock().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function isRuntimeFailure(error) {
  return ['runtime_unavailable', 'relay_timeout', 'relay_failed'].includes(error?.code);
}

function taskMessages(mission, task, session) {
  const userMessages = session.events
    .filter((event) => event.kind === 'user_message')
    .map((event) => event.text)
    .filter(Boolean);
  return [
    {
      role: 'system',
      content: JSON.stringify({
        instruction: 'Complete one bounded internal Agent Calendar task. Do not perform external side effects. Return evidence and limitations.',
        mission: {
          title: mission.title,
          objective: mission.objective,
          successCriteria: mission.successCriteria,
          forbiddenActions: mission.policy?.forbiddenActions || [],
        },
      }),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: {
          title: task.title,
          reason: task.reason,
          expectedOutput: task.expectedOutput,
          actionClass: task.actionClass,
          sourceRefs: task.sourceRefs,
          dueAt: task.dueAt,
        },
        userMessages,
      }),
    },
  ];
}

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
  }

  async tick() {
    const checkedAt = this.clock().toISOString();
    const result = {
      checkedAt,
      startedTaskIds: [],
      completedTaskIds: [],
      blockedTaskIds: [],
      failedTaskIds: [],
      createdReportIds: [],
    };
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
      await this.#executeTask(task, result);
    }
    return result;
  }

  async #executeTask(task, result) {
    const mission = this.store.getAgentMissions().find((item) => item.id === task.missionId);
    const session = this.store.getAgentSession(task.sessionId);
    if (!mission || !session) return;

    const startedAt = this.clock().toISOString();
    const runningTask = this.store.updateTask(task.id, {
      status: 'running',
      startedAt,
      blockedReason: '',
      failureCode: '',
      attempt: Number(task.attempt || 0) + 1,
    });
    this.store.updateAgentSession(session.id, { status: 'running' });
    this.store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
      kind: 'progress',
      text: 'Mac mini Hermes에서 작업을 시작했습니다.',
      metadata: { startedAt, attempt: runningTask.attempt },
    }));
    result.startedTaskIds.push(task.id);

    try {
      const completion = await this.executeCompletion({
        payload: {
          model: task.createdByAgentId || task.agent || mission.agentId,
          stream: true,
          messages: taskMessages(mission, task, this.store.getAgentSession(session.id)),
        },
        meta: {
          missionId: mission.id,
          taskId: task.id,
          sessionId: session.id,
          idempotencyKey: task.id,
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

      let report = null;
      if (task.actionClass === 'report') {
        let parsed;
        try {
          parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
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
      this.#recordBudget(mission, task);
      result.completedTaskIds.push(task.id);
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
  }

  #recordBudget(mission, task) {
    const budget = mission.budget || {};
    this.store.updateAgentMission(mission.id, {
      budget: {
        ...budget,
        usedRuns: Number(budget.usedRuns || 0) + 1,
        usedMinutes: Number(budget.usedMinutes || 0) + Number(task.estimatedMinutes || 0),
      },
    });
  }
}

module.exports = {
  AgentOperationsScheduler,
  taskMessages,
};
