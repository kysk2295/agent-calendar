const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const DEFAULT_EVENT_TIMEOUT_MS = 90_000;
const DEFAULT_BRIDGE_TTL_MS = 45_000;
const DEFAULT_SNAPSHOT_TTL_MS = 45_000;

function nowMs() {
  return Date.now();
}

function createRelayId(prefix = 'relay') {
  return `${prefix}-${nowMs().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function relayToken(env = process.env) {
  return String(env.HERMES_RELAY_TOKEN || env.HERMES_BRIDGE_TOKEN || '').trim();
}

function relayEnabled(env = process.env) {
  const token = relayToken(env);
  if (!token) return false;
  const value = String(env.HERMES_RELAY_ENABLED || '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(value);
}

function isRelayAuthorized(req, env = process.env) {
  const expected = relayToken(env);
  if (!expected) return false;
  const headers = req.headers || {};
  const headerToken = String(headers['x-hermes-relay-token'] || headers['x-hermes-bridge-token'] || '').trim();
  if (headerToken && headerToken === expected) return true;
  const authorization = String(headers.authorization || '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(bearer && bearer[1].trim() === expected);
}

class HermesRailwayRelay {
  constructor({ clock = nowMs } = {}) {
    this.clock = clock;
    this.pendingJobs = [];
    this.jobs = new Map();
    this.pollWaiters = [];
    this.eventWaiters = new Map();
    this.lastBridgeSeenAt = 0;
    this.lastSnapshot = null;
  }

  status({ env = process.env } = {}) {
    const snapshot = this.snapshot({ env });
    return {
      ok: relayEnabled(env),
      mode: 'railway-relay',
      bridgeOnline: this.isBridgeOnline(),
      lastBridgeSeenAt: this.lastBridgeSeenAt ? new Date(this.lastBridgeSeenAt).toISOString() : '',
      pendingJobs: this.pendingJobs.length,
      activeJobs: [...this.jobs.values()].filter((job) => !job.complete).length,
      liveSnapshotOnline: Boolean(snapshot && snapshot.ok),
      lastSnapshotAt: snapshot?.receivedAt || '',
    };
  }

  isBridgeOnline(ttlMs = DEFAULT_BRIDGE_TTL_MS) {
    if (this.pollWaiters.length > 0) return true;
    return this.lastBridgeSeenAt > 0 && this.clock() - this.lastBridgeSeenAt <= ttlMs;
  }

  enqueue({ kind, payload, meta = {} }) {
    const job = {
      id: createRelayId('relay-job'),
      kind,
      payload,
      meta,
      events: [],
      cursor: 0,
      complete: false,
      createdAt: new Date(this.clock()).toISOString(),
      updatedAt: new Date(this.clock()).toISOString(),
    };
    this.jobs.set(job.id, job);
    this.pendingJobs.push(job);
    this.flushPollWaiters();
    return job;
  }

  async poll({ timeoutMs = DEFAULT_POLL_TIMEOUT_MS } = {}) {
    this.lastBridgeSeenAt = this.clock();
    const job = this.pendingJobs.shift();
    if (job) return { ok: true, job: this.publicJob(job) };
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.pollWaiters = this.pollWaiters.filter((item) => item !== waiter);
          resolve({ ok: true, job: null, mode: 'railway-relay' });
        }, Math.max(1, timeoutMs)),
      };
      this.pollWaiters.push(waiter);
    });
  }

  appendEvent(jobId, event) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const record = {
      id: `${job.id}:${job.events.length}`,
      event: String(event.event || 'message'),
      data: event.data === undefined ? {} : event.data,
      createdAt: new Date(this.clock()).toISOString(),
    };
    job.events.push(record);
    job.updatedAt = record.createdAt;
    this.flushEventWaiters(jobId);
    return record;
  }

  updateSnapshot(snapshot = {}) {
    const receivedAtMs = this.clock();
    this.lastBridgeSeenAt = receivedAtMs;
    this.lastSnapshot = {
      ...snapshot,
      receivedAt: new Date(receivedAtMs).toISOString(),
      receivedAtMs,
      source: snapshot.source || 'railway-relay-bridge',
    };
    return this.snapshot({ allowStale: true });
  }

  snapshot({ env = process.env, allowStale = false } = {}) {
    if (!this.lastSnapshot) return null;
    const ttlMs = Math.max(1, Number(env.HERMES_RELAY_SNAPSHOT_TTL_MS || DEFAULT_SNAPSHOT_TTL_MS));
    const ageMs = this.clock() - Number(this.lastSnapshot.receivedAtMs || 0);
    const stale = ageMs > ttlMs;
    if (stale && !allowStale) return null;
    const { receivedAtMs, ...publicSnapshot } = this.lastSnapshot;
    return {
      ok: !stale,
      stale,
      ageMs,
      ttlMs,
      ...publicSnapshot,
    };
  }

  complete(jobId, data = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!job.complete) {
      if (data && Object.keys(data).length) {
        this.appendEvent(jobId, { event: 'bridge-complete', data });
      }
      job.complete = true;
      job.updatedAt = new Date(this.clock()).toISOString();
      this.flushEventWaiters(jobId);
    }
    return job;
  }

  fail(jobId, error) {
    const message = error && error.message ? error.message : String(error || 'relay job failed');
    this.appendEvent(jobId, { event: 'error', data: { error: message, source: 'railway-relay' } });
    return this.complete(jobId, { ok: false, error: message });
  }

  async waitForEvents(jobId, cursor = 0, timeoutMs = DEFAULT_EVENT_TIMEOUT_MS) {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: 'relay_job_not_found', events: [], complete: true, cursor };
    if (job.events.length > cursor || job.complete) {
      return this.eventBatch(job, cursor);
    }
    return new Promise((resolve) => {
      const waiter = {
        cursor,
        resolve,
        timer: setTimeout(() => {
          this.removeEventWaiter(jobId, waiter);
          resolve(this.eventBatch(job, cursor));
        }, Math.max(1, timeoutMs)),
      };
      const waiters = this.eventWaiters.get(jobId) || [];
      waiters.push(waiter);
      this.eventWaiters.set(jobId, waiters);
    });
  }

  publicJob(job) {
    return {
      id: job.id,
      kind: job.kind,
      payload: job.payload,
      meta: job.meta,
      createdAt: job.createdAt,
    };
  }

  eventBatch(job, cursor) {
    const events = job.events.slice(cursor);
    return {
      ok: true,
      events,
      complete: job.complete,
      cursor: cursor + events.length,
    };
  }

  flushPollWaiters() {
    while (this.pendingJobs.length && this.pollWaiters.length) {
      const waiter = this.pollWaiters.shift();
      clearTimeout(waiter.timer);
      const job = this.pendingJobs.shift();
      waiter.resolve({ ok: true, job: this.publicJob(job) });
    }
  }

  flushEventWaiters(jobId) {
    const job = this.jobs.get(jobId);
    const waiters = this.eventWaiters.get(jobId) || [];
    if (!job || !waiters.length) return;
    this.eventWaiters.delete(jobId);
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.resolve(this.eventBatch(job, waiter.cursor));
    });
  }

  removeEventWaiter(jobId, waiter) {
    const waiters = this.eventWaiters.get(jobId) || [];
    const next = waiters.filter((item) => item !== waiter);
    if (next.length) {
      this.eventWaiters.set(jobId, next);
    } else {
      this.eventWaiters.delete(jobId);
    }
  }
}

module.exports = {
  DEFAULT_EVENT_TIMEOUT_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_TTL_MS,
  HermesRailwayRelay,
  isRelayAuthorized,
  relayEnabled,
};
