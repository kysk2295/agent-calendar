const crypto = require('node:crypto');

const {
  DELIVERABLE_KINDS,
  EXECUTION_ENGINES,
  createGeneralAgentMission,
  createWeeklyOpportunityMission,
  sanitizeAgentReport,
  sanitizeSessionEvent,
} = require('./agent-operations-domain');
const {
  AgentOperationsInterventionError,
  addAgentSessionMessage,
  transitionAgentTaskWithIntervention,
} = require('./agent-operations-interventions');
const { AgentOperationsPlanError, planAgentMission } = require('./agent-operations-planner');
const { resolveRequestedOfficialProfile } = require('./official-profiles');
const {
  addWorkMessage,
  createWork,
  getWorkConversation,
  isAgentWorkError,
} = require('./agent-work-service');
const {
  AgentWorkLiveTurnError,
  streamWorkTurn,
} = require('./agent-work-live-turn');

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

function reconcileTerminalTaskSessions(store) {
  const state = store.getState();
  const terminalStatuses = new Set(['blocked', 'cancelled', 'completed', 'failed']);
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  for (const session of state.agentSessions) {
    if (!session.taskId || session.type === 'mission-thread') continue;
    const task = tasks.get(session.taskId);
    if (!task || task.missionId !== session.missionId || !terminalStatuses.has(task.status)) continue;
    if (session.status !== task.status) store.updateAgentSession(session.id, { status: task.status });
  }
  return store.getState();
}

class AgentOperationsService {
  constructor({
    store,
    clock = () => new Date(),
    planCompletion = null,
    taskCompletion = null,
    liveTurnCompletion = null,
    resolveAgentAvailability = null,
    sendTelegram = null,
    scheduler = null,
    daemon = null,
  } = {}) {
    if (!store) throw new AgentOperationsError('store_required', 'Agent operations store is required', 503);
    this.store = store;
    this.clock = clock;
    this.planCompletion = planCompletion;
    this.taskCompletion = taskCompletion;
    this.liveTurnCompletion = liveTurnCompletion;
    this.resolveAgentAvailability = resolveAgentAvailability;
    this.liveTurns = new Map();
    this.sendTelegram = sendTelegram;
    this.scheduler = scheduler;
    this.daemon = daemon;
  }

  listState() {
    const read = () => {
      const state = reconcileTerminalTaskSessions(this.store);
      return {
        ok: true,
        missions: this.store.getAgentMissions(),
        tasks: state.tasks.filter((task) => task.origin === 'agent'),
        sessions: state.agentSessions,
        reports: this.store.getAgentReports().map((report) => sanitizeAgentReport(report)),
        daemon: this.daemon?.status() || state.agentOperationsDaemon || {
          running: false,
          lastRun: null,
          lastError: null,
        },
      };
    };
    if (typeof this.store.refreshAgentOperations !== 'function') return read();
    const refreshed = this.store.refreshAgentOperations();
    return refreshed && typeof refreshed.then === 'function' ? refreshed.then(read) : read();
  }

  createMission(input = {}) {
    if (!['weekly-opportunity-brief', 'general-agent-work'].includes(input.templateId)) {
      throw new AgentOperationsError(
        'template_not_found',
        'Agent mission template was not found',
        422,
      );
    }
    const executionEngine = String(input.executionEngine || 'hermes').trim();
    if (!EXECUTION_ENGINES.includes(executionEngine)) {
      throw new AgentOperationsError(
        'execution_engine_invalid',
        'Execution engine must be auto, hermes, local_llm, or codex',
        422,
      );
    }
    const rawDeliverable = input.deliverable && typeof input.deliverable === 'object'
      ? input.deliverable
      : {};
    const deliverableKind = String(rawDeliverable.kind || 'report').trim();
    if (!DELIVERABLE_KINDS.includes(deliverableKind)) {
      throw new AgentOperationsError(
        'deliverable_invalid',
        'Deliverable kind must be report, document, image, or file',
        422,
      );
    }
    const deliverable = {
      kind: deliverableKind,
      format: String(rawDeliverable.format || (deliverableKind === 'report' ? 'markdown' : '')).trim(),
    };
    const id = createOperationId('mission', this.clock);
    const agentId = resolveRequestedOfficialProfile({ agentId: input.agentId });
    let mission;
    try {
      mission = input.templateId === 'general-agent-work'
        ? createGeneralAgentMission({
          id,
          title: input.title,
          objective: input.objective,
          agentId,
          executionEngine,
          deliverable,
          clock: this.clock,
        })
        : {
          ...createWeeklyOpportunityMission({ id, clock: this.clock }),
          executionEngine,
          deliverable,
          ...(String(input.agentId || '').trim() ? { agentId } : {}),
        };
    } catch (error) {
      throw new AgentOperationsError('mission_contract_invalid', error.message, 422);
    }
    return this.store.createAgentMission({
      ...mission,
      ...(String(input.title || '').trim() ? { title: String(input.title).trim() } : {}),
    });
  }

  async createWork(input = {}) {
    try {
      return await createWork({ store: this.store, clock: this.clock, input });
    } catch (error) {
      if (isAgentWorkError(error)) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  async addWorkMessage(missionId, input = {}) {
    try {
      return await addWorkMessage({
        store: this.store,
        clock: this.clock,
        missionId,
        input,
        transitionTask: (taskId, action) => this.transitionTask(taskId, action),
      });
    } catch (error) {
      if (isAgentWorkError(error)) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  async streamWorkTurn(missionId, input = {}, onEvent = async () => {}) {
    if (this.liveTurns.has(missionId)) {
      throw new AgentOperationsError(
        'work_turn_in_progress',
        'A live response is already in progress for this work',
        409,
      );
    }
    const completion = this.liveTurnCompletion || this.planCompletion || this.taskCompletion;
    const turn = streamWorkTurn({
      store: this.store,
      clock: this.clock,
      missionId,
      input,
      addMessage: (id, message) => this.addWorkMessage(id, message),
      completion,
      resolveAgentAvailability: this.resolveAgentAvailability,
      onEvent,
    });
    this.liveTurns.set(missionId, turn);
    try {
      return await turn;
    } catch (error) {
      if (error instanceof AgentWorkLiveTurnError) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    } finally {
      if (this.liveTurns.get(missionId) === turn) this.liveTurns.delete(missionId);
    }
  }

  getWorkConversation(missionId, options = {}) {
    try {
      const result = getWorkConversation({ store: this.store, missionId, options });
      if (result && typeof result.then === 'function') {
        return result.catch((error) => {
          if (isAgentWorkError(error)) {
            throw new AgentOperationsError(error.code, error.message, error.status);
          }
          throw error;
        });
      }
      return result;
    } catch (error) {
      if (isAgentWorkError(error)) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  async planMission(missionId) {
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
    if (mission.status === 'draft' && !tasks.length) {
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
      note: sanitizeSessionEvent({ kind: 'user_message', text: String(input.note || '').trim() }).text,
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
    return sanitizeAgentReport(updated);
  }

  recordReportFollowUpDecision(reportId, input = {}) {
    const report = this.store.getAgentReports().find((item) => item.id === reportId);
    if (!report) throw new AgentOperationsError('report_not_found', 'Agent report was not found', 404);
    const index = Number(input.index);
    const decision = String(input.decision || '');
    const safeReport = sanitizeAgentReport(report);
    const followUp = Array.isArray(safeReport.followUps) ? safeReport.followUps[index] : null;
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
    return sanitizeAgentReport(updated);
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

  async runTaskNow(taskId) {
    if (!this.scheduler || typeof this.scheduler.runTaskNow !== 'function') {
      throw new AgentOperationsError(
        'scheduler_unavailable',
        'Agent operations scheduler is unavailable',
        503,
      );
    }
    try {
      const run = await this.scheduler.runTaskNow(taskId);
      const task = this.store.getState().tasks.find((item) => item.id === taskId);
      const report = task?.reportId
        ? this.store.getAgentReports().find((item) => item.id === task.reportId)
        : null;
      return {
        run,
        task,
        ...(report ? { report: sanitizeAgentReport(report) } : {}),
      };
    } catch (error) {
      if (error?.code && error?.status) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  async startTaskNow(taskId) {
    if (!this.scheduler || typeof this.scheduler.startTaskNow !== 'function') {
      throw new AgentOperationsError(
        'scheduler_unavailable',
        'Agent operations scheduler is unavailable',
        503,
      );
    }
    try {
      const accepted = this.scheduler.startTaskNow(taskId);
      accepted.completion.catch(() => {});
      const task = await accepted.started;
      if (!task) {
        throw new AgentOperationsError(
          'task_not_started',
          'Agent Task could not be claimed for execution',
          409,
        );
      }
      return {
        accepted: true,
        acceptedAt: accepted.acceptedAt,
        taskId,
        task,
      };
    } catch (error) {
      if (error instanceof AgentOperationsError) throw error;
      if (error?.code && error?.status) {
        throw new AgentOperationsError(error.code, error.message, error.status);
      }
      throw error;
    }
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
