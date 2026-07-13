const crypto = require('node:crypto');

const {
  createWeeklyOpportunityMission,
  sanitizeSessionEvent,
} = require('./agent-operations-domain');
const {
  AgentOperationsInterventionError,
  addAgentSessionMessage,
  transitionAgentTaskWithIntervention,
} = require('./agent-operations-interventions');
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
    daemon = null,
  } = {}) {
    if (!store) throw new AgentOperationsError('store_required', 'Agent operations store is required', 503);
    this.store = store;
    this.clock = clock;
    this.planCompletion = planCompletion;
    this.taskCompletion = taskCompletion;
    this.sendTelegram = sendTelegram;
    this.scheduler = scheduler;
    this.daemon = daemon;
  }

  listState() {
    const state = this.store.getState();
    return {
      ok: true,
      missions: this.store.getAgentMissions(),
      tasks: state.tasks.filter((task) => task.origin === 'agent'),
      sessions: state.agentSessions,
      reports: this.store.getAgentReports(),
      daemon: this.daemon?.status() || state.agentOperationsDaemon || {
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
    if (mission.status === 'paused') {
      for (const task of tasks.filter((item) => item.missionPause === true)) {
        if (task.status === 'blocked') this.transitionTask(task.id, 'resume');
        this.store.updateTask(task.id, {
          missionPause: false,
          pauseRequestedAt: '',
          pauseMode: '',
        });
      }
    }
    return this.store.updateAgentMission(mission.id, {
      status: 'active',
      activatedAt: this.clock().toISOString(),
    });
  }

  transitionMission(missionId, action) {
    const mission = this.#mission(missionId);
    if (action === 'pause' && mission.status !== 'active') {
      throw new AgentOperationsError('invalid_mission_state', `Mission cannot pause from ${mission.status}`, 409);
    }
    if (action === 'cancel' && !['draft', 'active', 'paused'].includes(mission.status)) {
      throw new AgentOperationsError('invalid_mission_state', `Mission cannot cancel from ${mission.status}`, 409);
    }
    const eligibleStates = action === 'pause'
      ? new Set(['scheduled', 'running'])
      : new Set(['proposed', 'scheduled', 'running', 'blocked']);
    const tasks = this.store.getState().tasks.filter((task) => (
      task.missionId === mission.id && task.origin === 'agent' && eligibleStates.has(task.status)
    ));
    const transitioned = tasks.map((task) => {
      const updated = this.transitionTask(task.id, action);
      return action === 'pause'
        ? this.store.updateTask(updated.id, { missionPause: true })
        : updated;
    });
    const updatedMission = this.store.updateAgentMission(mission.id, {
      status: action === 'pause' ? 'paused' : 'cancelled',
      ...(action === 'pause'
        ? { pausedAt: this.clock().toISOString() }
        : { cancelledAt: this.clock().toISOString() }),
    });
    return { mission: updatedMission, tasks: transitioned };
  }

  transitionTask(taskId, action) {
    try {
      return transitionAgentTaskWithIntervention({
        store: this.store,
        taskId,
        action,
        clock: this.clock,
      });
    } catch (error) {
      if (error instanceof AgentOperationsInterventionError) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    }
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

  async addSessionMessage(sessionId, input = {}) {
    try {
      return addAgentSessionMessage({
        store: this.store,
        sessionId,
        input,
        clock: this.clock,
      });
    } catch (error) {
      if (error instanceof AgentOperationsInterventionError) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    }
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

  recordReportFollowUpDecision(reportId, input = {}) {
    const report = this.store.getAgentReports().find((item) => item.id === reportId);
    if (!report) throw new AgentOperationsError('report_not_found', 'Agent report was not found', 404);
    const index = Number(input.index);
    const decision = String(input.decision || '');
    const followUp = Array.isArray(report.followUps) ? report.followUps[index] : null;
    if (!Number.isInteger(index) || index < 0 || !followUp || !['approved', 'rejected'].includes(decision)) {
      throw new AgentOperationsError('follow_up_decision_invalid', 'A valid follow-up and decision are required', 422);
    }
    const recordedAt = this.clock().toISOString();
    const record = {
      index,
      title: String(followUp.title || ''),
      reason: String(followUp.reason || ''),
      decision,
      recordedAt,
    };
    const existing = Array.isArray(report.followUpDecisions) ? report.followUpDecisions : [];
    const updated = this.store.updateAgentReport(report.id, {
      followUpDecisions: [...existing.filter((item) => Number(item?.index) !== index), record],
    });
    if (report.sessionId && this.store.getAgentSession(report.sessionId)) {
      this.store.appendAgentSessionEvent(report.sessionId, sanitizeSessionEvent({
        kind: 'approval_response',
        text: `후속 제안 ${decision === 'approved' ? '승인' : '거절'}: ${record.title}`,
        metadata: { reportId: report.id, followUpIndex: index, decision, recordedAt },
      }));
    }
    const mission = this.#mission(report.missionId);
    const userFeedback = Array.isArray(mission.userFeedback) ? mission.userFeedback : [];
    this.store.updateAgentMission(mission.id, {
      userFeedback: [...userFeedback, { kind: 'follow_up_decision', reportId: report.id, ...record }],
    });
    return updated;
  }

  async tick() {
    if (this.daemon) return this.daemon.tickNow();
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

}

module.exports = {
  AgentOperationsError,
  AgentOperationsService,
};
