class SchedulerDaemon {
  constructor({
    intervalMs = 60_000,
    tick,
    clock = () => new Date(),
  } = {}) {
    if (typeof tick !== 'function') {
      throw new Error('SchedulerDaemon requires a tick function');
    }
    this.intervalMs = Number(intervalMs) || 60_000;
    this.tick = tick;
    this.clock = clock;
    this.timer = null;
    this.isTicking = false;
    this.lastRun = null;
    this.lastError = null;
  }

  start(intervalMs) {
    if (intervalMs) this.intervalMs = Number(intervalMs) || this.intervalMs;
    if (this.timer) return this.status();
    this.timer = setInterval(() => {
      this.tickNow().catch(() => {});
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this.status();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.status();
  }

  async tickNow() {
    const checkedAt = this.clock().toISOString();
    if (this.isTicking) {
      return { checkedAt, skipped: true, reason: 'tick already running' };
    }
    this.isTicking = true;
    try {
      const result = await this.tick();
      const createdRuns = Array.isArray(result.createdRuns) ? result.createdRuns.length : 0;
      this.lastRun = {
        checkedAt,
        skipped: false,
        createdRuns,
      };
      this.lastError = null;
      return { ...result, checkedAt: result.checkedAt || checkedAt, skipped: false };
    } catch (error) {
      this.lastError = {
        checkedAt,
        message: error.message,
      };
      throw error;
    } finally {
      this.isTicking = false;
    }
  }

  status() {
    return {
      running: Boolean(this.timer),
      intervalMs: this.intervalMs,
      isTicking: this.isTicking,
      lastRun: this.lastRun,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  SchedulerDaemon,
};
