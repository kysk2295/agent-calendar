'use strict';

const {
  listDesktopApiPaths,
  listProductionRoutes,
} = require('./production-route-registry');
const { clientV1ContractManifest } = require('./client-v1-contract');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MINIMUM_ZERO_TRAFFIC_DAYS = 28;

function routeKey(route) {
  return `${String(route.method || '').toUpperCase()} ${String(route.pathPattern || '')}`;
}

function policy(
  key,
  lifecycle,
  {
    consumer = '',
    replacement = '',
    removeAfter = '',
    reason = '',
  } = {},
) {
  return {
    key,
    lifecycle,
    consumer,
    replacement,
    removeAfter,
    reason,
  };
}

const routeLifecyclePolicyManifest = Object.freeze([
  policy('POST /api/phase1/auth/session', 'compatibility', {
    consumer: 'backend-test-identity-verifier',
    replacement: '/api/phase1/auth/desktop/start',
    removeAfter: '2026-09-30',
    reason: 'Public Desktop identity is WorkOS AuthKit; body-driven trusted session issue is test-only.',
  }),
  policy('GET /api/phase1/tasks', 'compatibility', {
    consumer: 'unsupported-phase1-compatibility',
    replacement: '/api/tasks',
    removeAfter: '2026-10-31',
  }),
  policy('GET /api/phase1/tasks/:id', 'compatibility', {
    consumer: 'unsupported-phase1-compatibility',
    replacement: '/api/tasks',
    removeAfter: '2026-10-31',
  }),
  policy('GET /api/phase1/calendar-events', 'compatibility', {
    consumer: 'unsupported-phase1-compatibility',
    replacement: '/api/calendar/events',
    removeAfter: '2026-10-31',
  }),
  policy('GET /api/phase1/calendar-events/:id', 'compatibility', {
    consumer: 'unsupported-phase1-compatibility',
    replacement: '/api/calendar/events',
    removeAfter: '2026-10-31',
  }),
  policy('GET /api/phase1/wiki/search', 'compatibility', {
    consumer: 'unsupported-phase1-compatibility',
    replacement: '/api/knowledge/search',
    removeAfter: '2026-10-31',
  }),
  policy('GET /api/phase1/agent-work/:sessionId/events', 'compatibility', {
    consumer: 'unsupported-phase1-compatibility',
    replacement: '/api/agent-operations/work/:missionId/conversation',
    removeAfter: '2026-10-31',
  }),
  policy('GET /api/phase1/agent-work/:sessionId/stream', 'compatibility', {
    consumer: 'unsupported-phase1-compatibility',
    replacement: '/api/agent-operations/work/:missionId/live',
    removeAfter: '2026-10-31',
  }),
  policy('GET /api/relay/status', 'compatibility', {
    consumer: 'legacy-macmini-relay-adapter',
    replacement: '/api/runner/device/heartbeat',
    removeAfter: '2026-12-31',
  }),
  policy('GET /api/relay/snapshot', 'compatibility', {
    consumer: 'legacy-macmini-relay-adapter',
    replacement: '/api/runner/device/capabilities',
    removeAfter: '2026-12-31',
  }),
  policy('POST /api/relay/snapshot', 'compatibility', {
    consumer: 'legacy-macmini-relay-adapter',
    replacement: '/api/runner/device/capabilities',
    removeAfter: '2026-12-31',
  }),
  policy('GET /api/relay/poll', 'compatibility', {
    consumer: 'legacy-macmini-relay-adapter',
    replacement: '/api/runner/device/next-offer',
    removeAfter: '2026-12-31',
  }),
  policy('POST /api/relay/jobs/:id/events', 'compatibility', {
    consumer: 'legacy-macmini-relay-adapter',
    replacement: '/api/runner/device/event',
    removeAfter: '2026-12-31',
  }),
  policy('POST /api/relay/jobs/:id/complete', 'compatibility', {
    consumer: 'legacy-macmini-relay-adapter',
    replacement: '/api/runner/device/complete',
    removeAfter: '2026-12-31',
  }),

  policy('POST /api/phase1/agent-work/:sessionId/publish', 'security-tombstone', {
    reason: 'Untrusted clients must never forge Runner checkpoints.',
  }),
  policy('POST /api/phase1/schedule/embed-probe', 'security-tombstone', {
    reason: 'Synthetic embedding probes must remain explicitly unavailable.',
  }),

  policy('POST /api/tasks/share-draft', 'removal-candidate', {
    replacement: '/api/tasks',
    removeAfter: '2026-10-31',
    reason: 'No supported client calls the retired share-draft mutation.',
  }),
  policy('POST /api/scheduler/tick', 'removal-candidate', {
    replacement: '/api/scheduler/jobs/:id/run',
    removeAfter: '2026-10-31',
    reason: 'Scheduler ownership is durable and server-driven.',
  }),
  policy('POST /api/ticktick/import', 'removal-candidate', {
    replacement: '/api/automation/sources',
    removeAfter: '2026-10-31',
    reason: 'TickTick migration is replaced by source-owned Connected Automation.',
  }),
  policy('POST /api/ticktick/sync', 'removal-candidate', {
    replacement: '/api/automation/sources/:id/sync',
    removeAfter: '2026-10-31',
    reason: 'TickTick migration is replaced by source-owned Connected Automation.',
  }),
  policy('GET /api/runner/adapters', 'removal-candidate', {
    replacement: '/api/runners',
    removeAfter: '2026-10-31',
    reason: 'Production engine truth comes from account-bound Runner capabilities.',
  }),
  policy('POST /api/runner/enroll', 'removal-candidate', {
    replacement: '/api/runners/enrollments',
    removeAfter: '2026-10-31',
    reason: 'Legacy reusable enrollment is replaced by owner-confirmed one-use enrollment.',
  }),
  policy('POST /api/calendar/draft', 'removal-candidate', {
    replacement: '/api/assistant/ingest',
    removeAfter: '2026-10-31',
    reason: 'Calendar AI already uses review-only ingest before an explicit Calendar event create.',
  }),
  policy('POST /api/agent-operations/tick', 'removal-candidate', {
    replacement: '/api/agent-operations/tasks/:id/run-now',
    removeAfter: '2026-10-31',
    reason: 'Production scheduling is server-owned; users run one scoped Agent Task at a time.',
  }),
  policy('POST /api/workboard/convert', 'removal-candidate', {
    replacement: '/api/agent-operations/work',
    removeAfter: '2026-10-31',
    reason: 'Delegated work now enters a Workspace-scoped plan, review, and execution flow.',
  }),
  policy('POST /api/mail/accounts', 'removal-candidate', {
    replacement: '/api/mail/messages',
    removeAfter: '2026-10-31',
    reason: 'Desktop no longer collects Gmail app passwords; Mail connection requires a future account-bound OAuth connector.',
  }),
  policy('POST /api/mail/sync', 'removal-candidate', {
    replacement: '/api/mail/messages',
    removeAfter: '2026-10-31',
    reason: 'Desktop Mail is read-only until an account-bound OAuth connector owns provider synchronization.',
  }),
  policy('POST /api/mail/messages/:id/:action', 'removal-candidate', {
    replacement: '/api/agent-operations/work',
    removeAfter: '2026-10-31',
    reason: 'Unsupported provider mutations were removed; Mail content can still enter the supported Agent Work flow.',
  }),

  policy('POST /api/calendar/sources/google/authorize', 'stable-main-process', {
    consumer: 'desktop-main-calendar-oauth',
  }),
  policy('POST /api/calendar/sources/google/callback', 'stable-main-process', {
    consumer: 'desktop-main-calendar-oauth',
  }),
  policy('POST /api/calendar/sources/:id/watch', 'stable-control-plane', {
    consumer: 'calendar-watch-renewal',
  }),
  policy('PATCH /api/agents/:id', 'stable-control-plane', {
    consumer: 'workspace-agent-management',
  }),
  policy('POST /api/agents/catalog/requests', 'stable-control-plane', {
    consumer: 'workspace-agent-provider-import',
  }),
  policy('GET /api/agents/catalog/requests/:id', 'stable-control-plane', {
    consumer: 'workspace-agent-provider-import',
  }),
  policy('POST /api/agents/catalog/requests/:id/import', 'stable-control-plane', {
    consumer: 'workspace-agent-provider-import',
  }),
  policy('GET /api/agents/:id/sessions', 'stable-control-plane', {
    consumer: 'workspace-agent-session-management',
  }),
  policy('PATCH /api/agent-sessions/:id', 'stable-control-plane', {
    consumer: 'workspace-agent-session-management',
  }),
  policy('POST /api/agents/:id/sessions/catalog/requests', 'stable-control-plane', {
    consumer: 'workspace-agent-session-import',
  }),
  policy('POST /api/agents/:id/sessions/catalog/requests/:requestId/import', 'stable-control-plane', {
    consumer: 'workspace-agent-session-import',
  }),
  policy('DELETE /api/agents/:id', 'stable-control-plane', {
    consumer: 'workspace-agent-management',
  }),
  policy('POST /api/agents/:id/restore', 'stable-control-plane', {
    consumer: 'workspace-agent-management',
  }),
]);

const routeLifecyclePolicyByKey = new Map(
  routeLifecyclePolicyManifest.map((entry) => [entry.key, entry]),
);

function stableEntry(route, lifecycle, consumer) {
  return {
    key: routeKey(route),
    lifecycle,
    consumer,
    replacement: '',
    removeAfter: '',
    reason: '',
    class: route.class,
    action: route.action,
  };
}

function classifyRoute(route, desktopPaths, v1Paths) {
  const key = routeKey(route);
  if (v1Paths.has(key)) return stableEntry(route, 'stable-v1', 'desktop-and-mobile');
  if (desktopPaths.has(key)) {
    if (route.class === 'production_disabled') {
      return stableEntry(route, 'supported-client-disabled', 'desktop');
    }
    return stableEntry(route, 'stable-desktop', 'desktop');
  }

  const explicit = routeLifecyclePolicyByKey.get(key);
  if (explicit) {
    return {
      ...explicit,
      class: route.class,
      action: route.action,
    };
  }

  if (route.class === 'public_infra' || route.class === 'operations_private') {
    return stableEntry(route, 'stable-infrastructure', 'production-operations');
  }
  if (route.class === 'runner_device') {
    return stableEntry(route, 'stable-runner-protocol', 'account-bound-runner');
  }
  if (route.class === 'provider_webhook') {
    return stableEntry(route, 'stable-provider-ingress', 'configured-provider');
  }
  if (route.class === 'auth_public' || route.class === 'auth_session') {
    return stableEntry(route, 'stable-identity', 'desktop-and-future-mobile');
  }
  return null;
}

function dateMs(value, label) {
  const text = String(value || '');
  if (!ISO_DATE.test(text)) throw new Error(`route_lifecycle_invalid_${label}`);
  const ms = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error(`route_lifecycle_invalid_${label}`);
  return ms;
}

function buildRouteLifecycleReport({
  asOf = new Date().toISOString().slice(0, 10),
  routes = listProductionRoutes(),
  desktopPaths = listDesktopApiPaths(),
  contractManifest = clientV1ContractManifest,
} = {}) {
  dateMs(asOf, 'as_of');
  const desktop = new Set(desktopPaths);
  const v1 = new Set(
    contractManifest.families
      .flatMap((family) => family.operations)
      .map((route) => routeKey(route)),
  );
  const registeredKeys = new Set(routes.map((route) => routeKey(route)));
  const classified = [];
  const unclassifiedRoutes = [];
  for (const route of routes) {
    const entry = classifyRoute(route, desktop, v1);
    if (!entry) unclassifiedRoutes.push(routeKey(route));
    else classified.push(entry);
  }

  const stalePolicyEntries = routeLifecyclePolicyManifest
    .map((entry) => entry.key)
    .filter((key) => !registeredKeys.has(key))
    .sort();
  unclassifiedRoutes.sort();
  classified.sort((left, right) => left.key.localeCompare(right.key));

  const lifecycleCounts = {};
  for (const route of classified) {
    lifecycleCounts[route.lifecycle] = (lifecycleCounts[route.lifecycle] || 0) + 1;
  }
  const supportedClientDisabledRoutes = classified
    .filter((route) => route.lifecycle === 'supported-client-disabled')
    .map((route) => route.key)
    .sort();
  const compatibilityRoutes = classified
    .filter((route) => route.lifecycle === 'compatibility')
    .map((route) => route.key)
    .sort();
  const removalCandidates = classified
    .filter((route) => route.lifecycle === 'removal-candidate')
    .map((route) => route.key)
    .sort();
  const testOnlyRoutes = classified
    .filter((route) => route.lifecycle === 'test-only')
    .map((route) => route.key)
    .sort();
  const mobileEntryBlockers = [
    ...unclassifiedRoutes.map((key) => `unclassified_route:${key}`),
    ...stalePolicyEntries.map((key) => `stale_route_policy:${key}`),
    ...supportedClientDisabledRoutes.map((key) => `supported_client_disabled_route:${key}`),
    ...compatibilityRoutes.map((key) => `compatibility_route_present:${key}`),
    ...removalCandidates.map((key) => `removal_candidate_present:${key}`),
    ...testOnlyRoutes.map((key) => `test_only_production_route:${key}`),
  ];

  return Object.freeze({
    schemaVersion: 1,
    asOf,
    totalRoutes: routes.length,
    classifiedRoutes: classified.length,
    classificationComplete: unclassifiedRoutes.length === 0 && stalePolicyEntries.length === 0,
    mobileEntryReady: mobileEntryBlockers.length === 0,
    lifecycleCounts: Object.freeze({ ...lifecycleCounts }),
    supportedClientDisabledRoutes: Object.freeze(supportedClientDisabledRoutes),
    compatibilityRoutes: Object.freeze(compatibilityRoutes),
    removalCandidates: Object.freeze(removalCandidates),
    testOnlyRoutes: Object.freeze(testOnlyRoutes),
    unclassifiedRoutes: Object.freeze(unclassifiedRoutes),
    stalePolicyEntries: Object.freeze(stalePolicyEntries),
    mobileEntryBlockers: Object.freeze(mobileEntryBlockers),
    routes: Object.freeze(classified.map((route) => Object.freeze({ ...route }))),
  });
}

function assertRouteLifecycleClassified(report = buildRouteLifecycleReport()) {
  if (report.unclassifiedRoutes.length) {
    throw new Error(`route_lifecycle_unclassified:${report.unclassifiedRoutes.join(',')}`);
  }
  if (report.stalePolicyEntries.length) {
    throw new Error(`route_lifecycle_stale_policy:${report.stalePolicyEntries.join(',')}`);
  }
  return true;
}

function assertMobileEntryRouteLifecycle(report = buildRouteLifecycleReport()) {
  assertRouteLifecycleClassified(report);
  if (!report.mobileEntryReady) {
    throw new Error(`route_lifecycle_mobile_entry_blocked:${report.mobileEntryBlockers.join(',')}`);
  }
  return true;
}

function assertRouteRemovalAllowed(key, {
  asOf = '',
  zeroTrafficSince = '',
  minimumObservationDays = MINIMUM_ZERO_TRAFFIC_DAYS,
} = {}) {
  const report = buildRouteLifecycleReport({ asOf });
  assertRouteLifecycleClassified(report);
  const route = report.routes.find((entry) => entry.key === String(key || ''));
  if (!route) throw new Error('route_removal_unknown_route');
  if (route.lifecycle === 'security-tombstone') {
    throw new Error('security_tombstone_removal_forbidden');
  }
  if (!['compatibility', 'removal-candidate', 'test-only'].includes(route.lifecycle)) {
    throw new Error('stable_route_removal_forbidden');
  }
  if (!route.removeAfter) throw new Error('route_removal_date_missing');
  const asOfMs = dateMs(asOf, 'as_of');
  const removeAfterMs = dateMs(route.removeAfter, 'remove_after');
  if (asOfMs < removeAfterMs) throw new Error('removal_date_not_reached');
  const zeroTrafficMs = dateMs(zeroTrafficSince, 'zero_traffic_since');
  const observedDays = Math.floor((asOfMs - zeroTrafficMs) / 86_400_000);
  const requiredDays = Number(minimumObservationDays);
  if (!Number.isInteger(requiredDays) || requiredDays < MINIMUM_ZERO_TRAFFIC_DAYS) {
    throw new Error('zero_traffic_window_invalid');
  }
  if (observedDays < requiredDays) throw new Error('zero_traffic_window_incomplete');
  return true;
}

module.exports = {
  MINIMUM_ZERO_TRAFFIC_DAYS,
  assertMobileEntryRouteLifecycle,
  assertRouteLifecycleClassified,
  assertRouteRemovalAllowed,
  buildRouteLifecycleReport,
  routeLifecyclePolicyManifest,
};
