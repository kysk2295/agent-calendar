const crypto = require('node:crypto');

const {
  createWeeklyOpportunityMission,
  sanitizeSessionEvent,
  transitionAgentTask,
} = require('./agent-operations-domain');
const { AgentOperationsPlanError, planAgentMission } = require('./agent-operations-planner');

class AgentOperationsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AgentOperationsError';
    this.code = code;
    this.status = status;
  }
}

function createOperationId(prefix, clock) {
  const stamp = clock().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

class AgentOperationsService {
  constructor({
    store,
    clock = () => new Date(),
    planCompletion = null,
    taskCompletion = null,
    sendTelegram = null,
    scheduler = null,
  } = {}) {
    if (!store) throw new AgentOperationsError('store_required', 'Agent operations store is required', 503);
    this.store = store;
    this.clock = clock;
    this.planCompletion = planCompletion;
    this.taskCompletion = taskCompletion;
    this.sendTelegram = sendTelegram;
    this.scheduler = scheduler;
  }

  listState() {
    const state = this.store.getState();
    return {
      ok: true,
      missions: this.store.getAgentMissions(),
      tasks: state.tasks.filter((task) => task.origin === 'agent'),
      sessions: state.agentSessions,
      reports: this.store.getAgentReports(),
      daemon: state.agentOperationsDaemon || {
        running: false,
        lastRun: null,
        lastError: null,
      },
    };
  }

  createMission(input = {}) {
    if (input.templateId !== 'weekly-opportunity-brief') {
      throw new AgentOperationsError(
        'template_not_found',
        'Only the Weekly Opportunity Brief template is available',
        422,
      );
    }
    const id = createOperationId('mission', this.clock);
    const mission = createWeeklyOpportunityMission({ id, clock: this.clock });
    return this.store.createAgentMission({
      ...mission,
      ...(String(input.title || '').trim() ? { title: String(input.title).trim() } : {}),
    });
  }

  async planMission(missionId) {
    if (!this.planCompletion) {
      throw new AgentOperationsError(
        'runtime_unavailable',
        'Mac mini Hermes planning is unavailable',
        503,
      );
    }
    const mission = this.#mission(missionId);
    try {
      return await planAgentMission({
        store: this.store,
        mission,
        planCompletion: this.planCompletion,
        clock: this.clock,
      });
    } catch (error) {
      if (error instanceof AgentOperationsPlanError) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  activateMission(missionId) {
    const mission = this.#mission(missionId);
    const tasks = this.store.getState().tasks.filter((task) => task.missionId === mission.id);
    if (!tasks.length) {
      throw new AgentOperationsError(
        'mission_plan_required',
        'Create and review a mission plan before activation',
        409,
      );
    }
    if (!['draft', 'paused'].includes(mission.status)) {
      throw new AgentOperationsError(
        'invalid_mission_state',
        `Mission cannot activate from ${mission.status}`,
        409,
      );
    }
    return this.store.updateAgentMission(mission.id, {
      status: 'active',
      activatedAt: this.clock().toISOString(),
    });
  }

  transitionTask(taskId, action) {
    const task = this.#task(taskId);
    let transitioned;
    try {
      transitioned = transitionAgentTask(task, action, { clock: this.clock });
    } catch (error) {
      throw new AgentOperationsError('invalid_task_transition', error.message, 409);
    }
    const updated = this.store.updateTask(task.id, transitioned);
    if (updated.sessionId) {
      this.store.appendAgentSessionEvent(updated.sessionId, sanitizeSessionEvent({
        kind: 'approval_response',
        text: `${action}: ${task.status} -> ${updated.status}`,
        metadata: { action, previousStatus: task.status, status: updated.status },
      }));
    }
    return updated;
  }

  getSession(sessionId) {
    const session = this.store.getAgentSession(sessionId);
    if (!session) {
      throw new AgentOperationsError('session_not_found', 'Task Session was not found', 404);
    }
    return {
      ...session,
      events: session.events.map((event) => sanitizeSessionEvent(event)),
    };
  }

  async addSessionMessage() {
    throw new AgentOperationsError(
      'runtime_unavailable',
      'Task Session continuation is unavailable',
      503,
    );
  }

  recordReportFeedback(reportId, input = {}) {
    const report = this.store.getAgentReports().find((item) => item.id === reportId);
    if (!report) throw new AgentOperationsError('report_not_found', 'Agent report was not found', 404);
    if (typeof input.useful !== 'boolean') {
      throw new AgentOperationsError('feedback_invalid', 'Feedback useful must be boolean', 422);
    }
    const feedback = {
      useful: input.useful,
      note: String(input.note || '').trim(),
      recordedAt: this.clock().toISOString(),
    };
    const updated = this.store.updateAgentReport(report.id, {
      useful: feedback.useful,
      feedback,
    });
    const mission = this.#mission(report.missionId);
    const userFeedback = Array.isArray(mission.userFeedback) ? mission.userFeedback : [];
    this.store.updateAgentMission(mission.id, {
      userFeedback: [...userFeedback, { reportId: report.id, ...feedback }],
    });
    return updated;
  }

  async tick() {
    if (!this.scheduler) {
      throw new AgentOperationsError(
        'scheduler_unavailable',
        'Agent operations scheduler is unavailable',
        503,
      );
    }
    return this.scheduler.tick();
  }

  #mission(missionId) {
    const mission = this.store.getAgentMissions().find((item) => item.id === missionId);
    if (!mission) throw new AgentOperationsError('mission_not_found', 'Agent mission was not found', 404);
    return mission;
  }

  #task(taskId) {
    const task = this.store.getState().tasks.find((item) => item.id === taskId && item.origin === 'agent');
    if (!task) throw new AgentOperationsError('task_not_found', 'Agent task was not found', 404);
    return task;
  }
}

module.exports = {
  AgentOperationsError,
  AgentOperationsService,
};
