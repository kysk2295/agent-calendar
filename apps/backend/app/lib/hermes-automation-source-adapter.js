'use strict';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function normalizeJob(value = {}) {
  const job = asObject(value);
  const externalId = firstText(job.id, job.externalId, job.key);
  const enabled = typeof job.enabled === 'boolean' ? job.enabled : null;
  const rawStatus = firstText(job.status, job.state).toLowerCase();
  const status = enabled === false || ['paused', 'disabled', 'stopped'].includes(rawStatus)
    ? 'paused'
    : enabled === true || ['active', 'enabled', 'ready', 'scheduled'].includes(rawStatus)
      ? 'active'
      : ['failed', 'error'].includes(rawStatus)
        ? 'failed'
        : 'unknown';
  return {
    externalId,
    name: firstText(job.name, job.title) || '이름 없는 Hermes 자동화',
    goal: firstText(job.goal, job.description, job.objective, job.prompt),
    agentId: firstText(job.agentId, job.agent, job.profile, job.profileId),
    schedule: firstText(job.schedule, job.scheduleDisplay, job.cron, job.cronExpression),
    status,
    enabled,
    revision: firstText(job.revision, job.etag, job.updatedAt),
    nextRunAt: firstText(job.nextRunAt, job.nextRun, job.scheduledAt),
    lastRunAt: firstText(job.lastRunAt, job.lastRun),
    lastStatus: firstText(job.lastStatus, job.lastResult),
  };
}

function normalizeRun(value = {}, automationExternalId = '') {
  const run = asObject(value);
  const externalOccurrenceId = firstText(run.externalOccurrenceId, run.id, run.runId);
  const scheduledAt = firstText(run.scheduledAt, run.startedAt, run.createdAt);
  if (!externalOccurrenceId || !scheduledAt) return null;
  return {
    externalOccurrenceId,
    automationExternalId: firstText(
      run.automationExternalId,
      run.automationId,
      run.jobId,
      automationExternalId,
    ),
    scheduledAt,
    startedAt: firstText(run.startedAt) || null,
    finishedAt: firstText(run.finishedAt, run.completedAt) || null,
    status: firstText(run.status) || 'unknown',
    revision: firstText(run.revision, run.etag),
    result: asObject(run.result),
  };
}

function sourceCapabilities() {
  return {
    list: true,
    create: true,
    update: true,
    pause: true,
    resume: true,
    run: true,
    delete: false,
    triggers: ['cron'],
    sessionReuse: false,
    runHistory: true,
  };
}

class HermesAutomationSourceAdapter {
  constructor({ request } = {}) {
    if (typeof request !== 'function') {
      throw new Error('HermesAutomationSourceAdapter requires request');
    }
    this.request = request;
  }

  async capabilities() {
    return sourceCapabilities();
  }

  async list(source, cursor = '') {
    const response = await this.request({
      source,
      method: 'GET',
      path: '/api/cron/jobs',
      query: cursor ? { cursor } : {},
    });
    const jobs = (Array.isArray(response?.jobs) ? response.jobs : [])
      .map(normalizeJob)
      .filter((job) => job.externalId);
    const occurrences = jobs.flatMap((job) => (
      job.nextRunAt
        ? [{
          externalOccurrenceId: `${job.externalId}:${job.nextRunAt}`,
          automationExternalId: job.externalId,
          scheduledAt: job.nextRunAt,
          status: 'scheduled',
          revision: job.revision,
          result: {},
        }]
        : []
    ));
    const runHistory = Array.isArray(response?.runs)
      ? response.runs.map((run) => normalizeRun(run)).filter(Boolean)
      : [];
    return {
      items: jobs,
      occurrences: [...occurrences, ...runHistory],
      cursor: firstText(response?.cursor, cursor),
      sourceRevision: firstText(response?.sourceRevision, response?.revision),
      capabilities: sourceCapabilities(),
    };
  }

  async create(source, input = {}) {
    const response = await this.request({
      source,
      method: 'POST',
      path: '/api/cron/jobs',
      body: {
        name: String(input.name || '새 자동화'),
        goal: String(input.goal || ''),
        agentId: String(input.agentId || ''),
        schedule: String(input.schedule || ''),
        enabled: false,
      },
      idempotencyKey: input.idempotencyKey,
    });
    return this.#mutationResult(response);
  }

  async update(source, input = {}) {
    return this.#mutate(source, input, {
      method: 'PUT',
      suffix: '',
      body: {
        name: input.name,
        goal: input.goal,
        agentId: input.agentId,
        schedule: input.schedule,
      },
    });
  }

  async pause(source, input = {}) {
    return this.#mutate(source, input, {
      method: 'POST',
      suffix: '/pause',
      body: {},
    });
  }

  async resume(source, input = {}) {
    return this.#mutate(source, input, {
      method: 'POST',
      suffix: '/resume',
      body: {},
    });
  }

  async run(source, input = {}) {
    return this.#mutate(source, input, {
      method: 'POST',
      suffix: '/trigger',
      body: {},
    });
  }

  async #mutate(source, input, { method, suffix, body }) {
    const externalId = String(input.externalId || '').trim();
    if (!externalId) {
      const error = new Error('Hermes automation id required');
      error.code = 'AUTOMATION_EXTERNAL_ID_REQUIRED';
      throw error;
    }
    const response = await this.request({
      source,
      method,
      path: `/api/cron/jobs/${encodeURIComponent(externalId)}${suffix}`,
      body: Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined),
      ),
      expectedRevision: String(input.expectedRevision || ''),
      idempotencyKey: String(input.idempotencyKey || ''),
    });
    return this.#mutationResult(response, externalId);
  }

  #mutationResult(response = {}, externalId = '') {
    const jobValue = response.job || response.updated || response.automation || null;
    const automation = jobValue ? normalizeJob(jobValue) : null;
    const run = response.run
      ? normalizeRun(response.run, externalId || automation?.externalId)
      : null;
    return {
      automation,
      run,
      sourceRevision: firstText(
        response.sourceRevision,
        response.revision,
        automation?.revision,
      ),
    };
  }
}

module.exports = {
  HermesAutomationSourceAdapter,
  normalizeJob,
  normalizeRun,
  sourceCapabilities,
};
