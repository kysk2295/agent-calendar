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
  }

  setAdapter(adapter) {
    this.adapter = adapter || null;
  }

  enqueueRun(run) {
    this.queue.push(run);
    this.emitEvent('run:queued', run, 'queued for no-approval runner');
    if (!this.active) {
      setTimeout(() => this.#drain(), 0);
    }
    return run;
  }

  async runOnce(run) {
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
    const adapter = this.adapterResolver ? this.adapterResolver(currentRun) : this.adapter;
    if (adapter) {
      const adapterId = adapter.id || '';
      const adapterMessage = adapterId ? `local command adapter started: ${adapterId}` : 'local command adapter started';
      this.store.appendRunLog(run.id, `${this.#time()} ${adapterMessage}`);
      this.emitEvent('run:log', currentRun, adapterMessage);
      let result;
      try {
        result = await adapter.execute(this.store.getRun(run.id) || run, {
          onLog: ({ stream, line } = {}) => {
            const message = `${stream || 'stdout'}: ${String(line || '').trim()}`;
            if (!String(line || '').trim()) return;
            const currentRun = this.store.appendRunLog(run.id, `${this.#time()} ${message}`) || run;
            this.emitEvent('run:log', currentRun, message);
          },
        });
      } catch (error) {
        const failedRun = this.store.updateRunStatus(run.id, 'failed');
        const message = error && error.message ? error.message : String(error);
        this.store.appendRunLog(run.id, `${this.#time()} adapter error: ${message}`);
        this.emitEvent('run:failed', failedRun || run, `adapter error: ${message}`);
        return this.store.getRun(run.id);
      }
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
