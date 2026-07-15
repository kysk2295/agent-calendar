const EventEmitter = require('node:events');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HermesRunner extends EventEmitter {
  constructor({ store, clock = () => new Date(), stepDelayMs = 80, adapterResolver = null } = {}) {
    super();
    this.store = store;
    this.clock = clock;
    this.stepDelayMs = stepDelayMs;
    this.queue = [];
    this.active = false;
    this.adapter = null;
    this.adapterResolver = typeof adapterResolver === 'function' ? adapterResolver : null;
    this.activeAdapters = new Map();
    this.stopDecisions = new Map();
  }

  setAdapter(adapter) {
    this.adapter = adapter || null;
  }

  enqueueRun(run) {
    const currentRun = this.store.getRun(run.id);
    if (currentRun?.status === 'stopped') return currentRun;
    this.queue.push(run);
    this.emitEvent('run:queued', run, 'queued for no-approval runner');
    if (!this.active) {
      setTimeout(() => this.#drain(), 0);
    }
    return run;
  }

  async runOnce(run) {
    const persistedRun = this.store.getRun(run.id);
    if (persistedRun?.status === 'stopped') return persistedRun;
    this.store.updateRunStatus(run.id, 'running');
    this.store.appendRunLog(run.id, `${this.#time()} runner started`);
    this.emitEvent('run:started', run, 'runner started');
    await wait(this.stepDelayMs);
    this.store.appendRunLog(run.id, `${this.#time()} reading task context`);
    this.emitEvent('run:log', run, 'reading task context');
    await wait(this.stepDelayMs);
    this.store.appendRunLog(run.id, `${this.#time()} wiki write-back prepared`);
    this.emitEvent('run:log', run, 'wiki write-back prepared');
    await wait(this.stepDelayMs);

    const currentRun = this.store.getRun(run.id) || run;
    if (currentRun.status === 'stopped') return currentRun;
    const adapter = this.adapterResolver ? this.adapterResolver(currentRun) : this.adapter;
    if (adapter) {
      const adapterId = adapter.id || '';
      const adapterMessage = adapterId ? `local command adapter started: ${adapterId}` : 'local command adapter started';
      this.store.appendRunLog(run.id, `${this.#time()} ${adapterMessage}`);
      this.emitEvent('run:log', currentRun, adapterMessage);
      let result;
      try {
        this.activeAdapters.set(run.id, adapter);
        result = await adapter.execute(this.store.getRun(run.id) || run, {
          onLog: ({ stream, line } = {}) => {
            const message = `${stream || 'stdout'}: ${String(line || '').trim()}`;
            if (!String(line || '').trim()) return;
            const currentRun = this.store.appendRunLog(run.id, `${this.#time()} ${message}`) || run;
            this.emitEvent('run:log', currentRun, message);
          },
        });
      } catch (error) {
        this.activeAdapters.delete(run.id);
        const stopDecision = this.stopDecisions.get(run.id);
        if (stopDecision) {
          const confirmed = await stopDecision.promise;
          this.stopDecisions.delete(run.id);
          if (confirmed) {
            const stoppedRun = this.store.getRun(run.id);
            this.store.appendRunLog(run.id, `${this.#time()} runner stopped`);
            this.emitEvent('run:stopped', stoppedRun || run, 'runner stopped');
            return this.store.getRun(run.id);
          }
        }
        const stoppedRun = this.store.getRun(run.id);
        if (stoppedRun?.status === 'stopped') {
          this.store.appendRunLog(run.id, `${this.#time()} runner stopped`);
          this.emitEvent('run:stopped', stoppedRun, 'runner stopped');
          return this.store.getRun(run.id);
        }
        const failedRun = this.store.updateRunStatus(run.id, 'failed');
        const message = error && error.message ? error.message : String(error);
        this.store.appendRunLog(run.id, `${this.#time()} adapter error: ${message}`);
        this.emitEvent('run:failed', failedRun || run, `adapter error: ${message}`);
        return this.store.getRun(run.id);
      }
      this.activeAdapters.delete(run.id);
      this.stopDecisions.delete(run.id);
      const stoppedRun = this.store.getRun(run.id);
      if (stoppedRun?.status === 'stopped') return stoppedRun;
      if (!result.streamedLogs && result.stdout && result.stdout.trim()) {
        this.store.appendRunLog(run.id, `${this.#time()} stdout: ${result.stdout.trim()}`);
        this.emitEvent('run:log', run, 'local command stdout captured');
      }
      if (!result.streamedLogs && result.stderr && result.stderr.trim()) {
        this.store.appendRunLog(run.id, `${this.#time()} stderr: ${result.stderr.trim()}`);
        this.emitEvent('run:log', run, 'local command stderr captured');
      }
      if (result.exitCode !== 0) {
        const failedRun = this.store.updateRunStatus(run.id, 'failed');
        this.store.appendRunLog(run.id, `${this.#time()} runner failed with exit ${result.exitCode}`);
        this.emitEvent('run:failed', failedRun || run, `runner failed with exit ${result.exitCode}`);
        return this.store.getRun(run.id);
      }
    }

    const doneRun = this.store.updateRunStatus(run.id, 'done');
    this.store.appendRunLog(run.id, `${this.#time()} runner completed`);
    this.emitEvent('run:done', doneRun || run, 'runner completed');
    return this.store.getRun(run.id);
  }

  async stopRun(runId) {
    const key = String(runId || '').trim();
    if (!key) return false;
    const queuedIndex = this.queue.findIndex((run) => run.id === key);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.store.updateRunStatus(key, 'stopped');
      return true;
    }
    const currentRun = this.store.getRun(key);
    if (!currentRun) return false;
    if (currentRun.status === 'stopped') return true;
    if (currentRun.status === 'queued') {
      this.store.updateRunStatus(key, 'stopped');
      return true;
    }
    if (currentRun.status !== 'running') return false;
    const adapter = this.activeAdapters.get(key);
    if (!adapter) {
      this.store.updateRunStatus(key, 'stopped');
      return true;
    }
    if (typeof adapter.stop !== 'function') return false;
    const existingDecision = this.stopDecisions.get(key);
    if (existingDecision) return existingDecision.promise;
    let resolveDecision;
    const decision = new Promise((resolve) => { resolveDecision = resolve; });
    this.stopDecisions.set(key, { promise: decision, resolve: resolveDecision });
    let confirmed = false;
    try {
      confirmed = await adapter.stop(key);
    } catch {
      confirmed = false;
    }
    if (confirmed) this.store.updateRunStatus(key, 'stopped');
    resolveDecision(confirmed);
    return confirmed;
  }

  emitEvent(type, run, message) {
    const event = {
      type,
      runId: run && run.id,
      run: run && run.name,
      agent: run && run.agent,
      message,
      time: this.clock().toISOString(),
    };
    this.emit('event', event);
    return event;
  }

  async #drain() {
    this.active = true;
    while (this.queue.length) {
      const run = this.queue.shift();
      await this.runOnce(run);
    }
    this.active = false;
  }

  #time() {
    return this.clock().toISOString().slice(11, 19);
  }
}

module.exports = {
  HermesRunner,
};
