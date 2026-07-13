const { resolveOfficialProfileName } = require('./official-profiles');

class Scheduler {
  constructor({ store, clock = () => new Date() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  createJob(input) {
    return this.store.createSchedulerJob(input);
  }

  listJobs() {
    return this.store.getSchedulerJobs();
  }

  updateJob(jobId, patch = {}) {
    const safePatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(safePatch, 'intervalMinutes')) {
      const intervalMinutes = Number(safePatch.intervalMinutes) || 1;
      safePatch.intervalMinutes = Math.max(1, intervalMinutes);
    }
    return this.store.updateSchedulerJob(jobId, safePatch);
  }

  deleteJob(jobId) {
    return this.store.deleteSchedulerJob(jobId);
  }

  runJobNow(jobId) {
    const job = this.listJobs().find((item) => item.id === jobId);
    if (!job) return null;
    const now = this.clock().toISOString();
    const run = this.store.createRun({
      name: job.name,
      goal: job.goal,
      agent: resolveOfficialProfileName(job.agent),
      model: job.model || 'Recommended',
      source: 'scheduler',
      noApproval: false,
    });
    const updatedJob = this.store.updateSchedulerJob(job.id, {
      lastRunAt: now,
      lastRunId: run.id,
      runCount: Number(job.runCount || 0) + 1,
    });
    return { run, job: updatedJob };
  }

  tick() {
    const now = this.clock();
    const checkedAt = now.toISOString();
    const createdRuns = [];

    for (const job of this.listJobs()) {
      if (!this.#isDue(job, now)) continue;
      const run = this.store.createRun({
        name: job.name,
        goal: job.goal,
        agent: resolveOfficialProfileName(job.agent),
        model: job.model || 'Recommended',
        source: 'scheduler',
        noApproval: false,
      });
      createdRuns.push(run);
      this.store.updateSchedulerJob(job.id, {
        lastRunAt: checkedAt,
        lastRunId: run.id,
        runCount: Number(job.runCount || 0) + 1,
      });
    }

    return { checkedAt, createdRuns };
  }

  #isDue(job, now) {
    if (!job || job.enabled === false) return false;
    const intervalMinutes = Number(job.intervalMinutes || 0);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return false;
    if (!job.lastRunAt) return true;
    const lastRunAt = new Date(job.lastRunAt).getTime();
    if (!Number.isFinite(lastRunAt)) return true;
    return now.getTime() - lastRunAt >= intervalMinutes * 60 * 1000;
  }
}

module.exports = {
  Scheduler,
};
