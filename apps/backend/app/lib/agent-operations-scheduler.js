const { createSchedulerResult } = require('./agent-operations-scheduler-support');
const { executeAgentTask } = require('./agent-task-executor');

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

  async runTaskNow(taskId) {
    const started = this.startTaskNow(taskId);
    return started.completion;
  }

  startTaskNow(taskId) {
    if (this.tickPromise) {
      const error = new Error('Agent operations scheduler is already running');
      error.code = 'scheduler_busy';
      error.status = 409;
      throw error;
    }
    const checkedAt = this.clock().toISOString();
    const result = createSchedulerResult(checkedAt);
    const task = this.store.getState().tasks.find((item) => item.id === taskId);
    if (!task || task.origin !== 'agent') {
      const error = new Error('Agent Task was not found');
      error.code = 'task_not_found';
      error.status = 404;
      throw error;
    }
    if (task.status !== 'scheduled') {
      const error = new Error(`Agent Task cannot run now from ${task.status}`);
      error.code = 'invalid_task_state';
      error.status = 409;
      throw error;
    }
    const mission = this.store.getAgentMissions().find((item) => item.id === task.missionId);
    if (!mission || mission.status !== 'active') {
      const error = new Error('Agent Task requires an active mission');
      error.code = 'mission_not_active';
      error.status = 409;
      throw error;
    }
    let didStart = false;
    let resolveStarted;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const completion = this.#executeTask(task, result, (runningTask) => {
      didStart = true;
      resolveStarted(runningTask);
    }).then(() => {
      return result;
    });
    completion.finally(() => {
      if (!didStart) resolveStarted(null);
    }).catch(() => {});
    this.tickPromise = completion;
    completion.finally(() => {
      if (this.tickPromise === completion) this.tickPromise = null;
    }).catch(() => {});
    return { acceptedAt: checkedAt, taskId, started, completion };
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

  async #executeTask(task, result, onStarted) {
    return executeAgentTask({
      store: this.store,
      clock: this.clock,
      executeCompletion: this.executeCompletion,
      sendTelegram: this.sendTelegram,
      task,
      result,
      onStarted,
    });
  }

}

module.exports = {
  AgentOperationsScheduler,
};
