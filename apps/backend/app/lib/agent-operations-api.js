const { AgentOperationsError } = require('./agent-operations-service');

const TASK_ACTIONS = new Set(['approve', 'pause', 'resume', 'cancel', 'retry']);
const MISSION_ACTIONS = new Set(['pause', 'cancel']);

function success(status, body) {
  return { status, body: { ok: true, ...body } };
}

function failure(error) {
  if (error instanceof AgentOperationsError) {
    return {
      status: error.status,
      body: { ok: false, error: error.code, message: error.message },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: 'agent_operations_failed',
      message: 'Agent operations request failed',
    },
  };
}

async function routeAgentOperations({ method, pathSegments, body = {}, service } = {}) {
  const segments = (Array.isArray(pathSegments) ? pathSegments : [])
    .map((segment) => decodeURIComponent(String(segment || '')))
    .filter(Boolean);
  const normalized = segments[0] === 'api' ? segments.slice(1) : segments;
  if (normalized[0] !== 'agent-operations') return null;
  if (!service) {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'agent_operations_unavailable',
        message: 'Agent operations storage is unavailable',
      },
    };
  }

  try {
    if (method === 'GET' && normalized.length === 1) {
      return { status: 200, body: service.listState() };
    }
    if (method === 'POST' && normalized[1] === 'missions' && normalized.length === 2) {
      return success(201, { mission: service.createMission(body) });
    }
    if (method === 'POST' && normalized[1] === 'missions' && normalized[2] && normalized[3] === 'plan') {
      return success(200, await service.planMission(normalized[2]));
    }
    if (method === 'POST' && normalized[1] === 'missions' && normalized[2] && normalized[3] === 'activate') {
      return success(200, { mission: service.activateMission(normalized[2]) });
    }
    if (method === 'POST' && normalized[1] === 'missions' && normalized[2] && MISSION_ACTIONS.has(normalized[3])) {
      return success(200, service.transitionMission(normalized[2], normalized[3]));
    }
    if (
      method === 'POST'
      && normalized[1] === 'tasks'
      && normalized[2]
      && TASK_ACTIONS.has(normalized[3])
    ) {
      return success(200, { task: service.transitionTask(normalized[2], normalized[3]) });
    }
    if (method === 'GET' && normalized[1] === 'sessions' && normalized[2] && normalized.length === 3) {
      return success(200, { session: service.getSession(normalized[2]) });
    }
    if (method === 'POST' && normalized[1] === 'sessions' && normalized[2] && normalized[3] === 'messages') {
      return success(200, await service.addSessionMessage(normalized[2], body));
    }
    if (method === 'POST' && normalized[1] === 'reports' && normalized[2] && normalized[3] === 'feedback') {
      return success(200, { report: service.recordReportFeedback(normalized[2], body) });
    }
    if (method === 'POST' && normalized[1] === 'reports' && normalized[2] && normalized[3] === 'follow-ups') {
      return success(200, { report: service.recordReportFollowUpDecision(normalized[2], body) });
    }
    if (method === 'POST' && normalized[1] === 'tick' && normalized.length === 2) {
      return success(200, { tick: await service.tick() });
    }
    return {
      status: 404,
      body: {
        ok: false,
        error: 'agent_operations_route_not_found',
        message: 'Agent operations route was not found',
      },
    };
  } catch (error) {
    return failure(error);
  }
}

module.exports = {
  routeAgentOperations,
};
