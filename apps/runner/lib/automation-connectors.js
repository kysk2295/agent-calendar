'use strict';

const PRIVATE_FIELD_PATTERN = /(api[_-]?key|authorization|cookie|credential|password|private|secret|token)/i;
const HOST_PATH_PATTERN = /(?:^|[\s"'=:])(?:\/Users\/|\/home\/|[A-Za-z]:\\|\\\\[^\\\s]+\\)/;
const SECRET_VALUE_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;

function connectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value, max = 500) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > max) {
    throw connectorError('CONNECTOR_OUTPUT_INVALID', 'automation metadata exceeds its public limit');
  }
  if (HOST_PATH_PATTERN.test(normalized) || SECRET_VALUE_PATTERN.test(normalized)) {
    throw connectorError('CONNECTOR_OUTPUT_SECRET', 'automation metadata contains private host data');
  }
  return normalized;
}

function assertSafeProviderResponse(value, depth = 0) {
  if (depth > 7) throw connectorError('CONNECTOR_OUTPUT_INVALID', 'automation response is too deep');
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    text(value, 4_000);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ENTRIES) {
      throw connectorError('CONNECTOR_OUTPUT_INVALID', 'automation response is too large');
    }
    value.forEach((entry) => assertSafeProviderResponse(entry, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') {
    throw connectorError('CONNECTOR_OUTPUT_INVALID', 'automation response is invalid');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_FIELD_PATTERN.test(key)) {
      throw connectorError('CONNECTOR_OUTPUT_SECRET', 'automation response contains a private field');
    }
    assertSafeProviderResponse(entry, depth + 1);
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return text(value);
    if (typeof value === 'number') return text(value);
  }
  return '';
}

function normalizeAutomation(value = {}) {
  const job = objectValue(value);
  const externalId = firstText(job.id, job.externalId, job.key);
  if (!externalId) throw connectorError('CONNECTOR_OUTPUT_INVALID', 'automation identity is required');
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

function normalizeOccurrence(value = {}, automationExternalId = '') {
  const run = objectValue(value);
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
    result: {},
  };
}

function capabilities() {
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

function loopbackBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/g, '');
  if (!raw || !URL.canParse(raw)) {
    throw connectorError(
      'CONNECTOR_AUTOMATION_NOT_CONFIGURED',
      'Runner-local Hermes automation endpoint is not configured',
    );
  }
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || !['127.0.0.1', 'localhost', '::1'].includes(host)
  ) {
    throw connectorError(
      'CONNECTOR_AUTOMATION_URL_INVALID',
      'Runner-local Hermes automation endpoint must be loopback',
    );
  }
  return raw;
}

function mutationRequest(input) {
  const action = String(input.action || '').trim().toLowerCase();
  const externalId = encodeURIComponent(String(input.externalId || '').trim());
  if (!['create', 'update', 'pause', 'resume', 'run'].includes(action)) {
    throw connectorError('CONNECTOR_AUTOMATION_ACTION_UNSUPPORTED', 'unsupported automation action');
  }
  if (action !== 'create' && !externalId) {
    throw connectorError('CONNECTOR_OUTPUT_INVALID', 'automation identity is required');
  }
  if (action === 'create') {
    return {
      method: 'POST',
      path: '/api/cron/jobs',
      body: {
        name: String(input.name || '새 자동화'),
        goal: String(input.goal || ''),
        agentId: String(input.agentId || ''),
        schedule: String(input.schedule || ''),
        enabled: false,
      },
    };
  }
  if (action === 'update') {
    return {
      method: 'PUT',
      path: `/api/cron/jobs/${externalId}`,
      body: {
        name: String(input.name || ''),
        goal: String(input.goal || ''),
        agentId: String(input.agentId || ''),
        schedule: String(input.schedule || ''),
      },
    };
  }
  return {
    method: 'POST',
    path: `/api/cron/jobs/${externalId}/${action === 'run' ? 'trigger' : action}`,
    body: {},
  };
}

function createHermesAutomationConnector({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  async function request(method, requestPath, body, input = {}) {
    const baseUrl = loopbackBaseUrl(env.AGENT_CALENDAR_HERMES_AUTOMATION_URL);
    const url = new URL(`${baseUrl}${requestPath}`);
    if (input.cursor) url.searchParams.set('cursor', String(input.cursor));
    if (input.expectedRevision) {
      url.searchParams.set('expectedRevision', String(input.expectedRevision));
    }
    if (input.idempotencyKey) {
      url.searchParams.set('idempotencyKey', String(input.idempotencyKey));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 15_000));
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(env.AGENT_CALENDAR_HERMES_AUTOMATION_TOKEN
            ? { authorization: `Bearer ${env.AGENT_CALENDAR_HERMES_AUTOMATION_TOKEN}` }
            : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw connectorError('SOURCE_TIMEOUT', 'Runner-local Hermes automation request timed out');
      }
      throw connectorError('CONNECTOR_AUTOMATION_UNAVAILABLE', 'Runner-local Hermes automation is unavailable');
    } finally {
      clearTimeout(timer);
    }
    const responseText = await response.text();
    if (Buffer.byteLength(responseText) > MAX_RESPONSE_BYTES) {
      throw connectorError('CONNECTOR_OUTPUT_INVALID', 'automation response is too large');
    }
    let payload;
    try {
      payload = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw connectorError('CONNECTOR_OUTPUT_INVALID', 'automation response is not JSON');
    }
    assertSafeProviderResponse(payload);
    if (!response.ok || payload?.ok === false) {
      if ([401, 403].includes(response.status)) {
        throw connectorError('CONNECTOR_AUTOMATION_AUTH_REQUIRED', 'Hermes automation authentication is required');
      }
      if ([409, 412].includes(response.status)) {
        throw connectorError('SOURCE_REVISION_CONFLICT', 'Hermes automation revision changed');
      }
      throw connectorError('CONNECTOR_AUTOMATION_FAILED', 'Hermes automation request failed');
    }
    return objectValue(payload);
  }

  return {
    async run(providerValue, input = {}) {
      if (input.consent !== true) {
        throw connectorError(
          'CONNECTOR_CONSENT_REQUIRED',
          'local automation access requires explicit consent',
        );
      }
      if (String(providerValue || '').trim().toLowerCase() !== 'hermes') {
        throw connectorError(
          'CONNECTOR_AUTOMATION_UNSUPPORTED',
          'provider has no supported local automation connector',
        );
      }
      if (input.kind === 'automation_capabilities') {
        await request('GET', '/api/cron/jobs', undefined, { cursor: '' });
        return capabilities();
      }
      if (input.kind === 'automation_list') {
        const payload = await request('GET', '/api/cron/jobs', undefined, input);
        const items = (Array.isArray(payload.jobs) ? payload.jobs : [])
          .map(normalizeAutomation)
          .slice(0, MAX_ENTRIES);
        const scheduled = items
          .filter((item) => item.nextRunAt)
          .map((item) => ({
            externalOccurrenceId: `${item.externalId}:${item.nextRunAt}`,
            automationExternalId: item.externalId,
            scheduledAt: item.nextRunAt,
            status: 'scheduled',
            revision: item.revision,
            result: {},
          }));
        const history = (Array.isArray(payload.runs) ? payload.runs : [])
          .map((run) => normalizeOccurrence(run))
          .filter(Boolean)
          .slice(0, MAX_ENTRIES);
        return {
          items,
          occurrences: [...scheduled, ...history].slice(0, MAX_ENTRIES),
          cursor: firstText(payload.cursor, input.cursor),
          sourceRevision: firstText(payload.sourceRevision, payload.revision),
          capabilities: capabilities(),
        };
      }
      if (input.kind !== 'automation_mutation') {
        throw connectorError('CONNECTOR_KIND_UNSUPPORTED', 'unsupported automation connector request');
      }
      const mutation = mutationRequest(input);
      const payload = await request(
        mutation.method,
        mutation.path,
        mutation.body,
        input,
      );
      const rawAutomation = payload.job || payload.updated || payload.automation || null;
      const automation = rawAutomation ? normalizeAutomation(rawAutomation) : null;
      const run = payload.run
        ? normalizeOccurrence(payload.run, input.externalId || automation?.externalId)
        : null;
      return {
        automation,
        run,
        sourceRevision: firstText(
          payload.sourceRevision,
          payload.revision,
          automation?.revision,
        ),
      };
    },
  };
}

module.exports = {
  createHermesAutomationConnector,
  normalizeAutomation,
  normalizeOccurrence,
};
