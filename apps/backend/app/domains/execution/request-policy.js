const RUN_ACTIONS = new Set(['approve', 'stop', 'retry']);

function classifyExecutionRequest({ method = 'GET', pathSegments = [] } = {}) {
  const segments = Array.isArray(pathSegments) ? pathSegments : [];
  const runCreate = method === 'POST' && segments[0] === 'runs' && segments.length === 1;
  const runAction = method === 'POST'
    && segments[0] === 'runs'
    && Boolean(segments[1])
    && segments.length === 3
    && RUN_ACTIONS.has(segments[2]);
  const missionLaunch = method === 'POST'
    && segments[0] === 'missions'
    && segments[1] === 'launch';
  const missionSchedule = method === 'POST'
    && segments[0] === 'missions'
    && segments[1] === 'schedule';
  return {
    runCreate,
    runAction,
    missionLaunch,
    missionSchedule,
    relayEligible: runCreate || runAction || missionLaunch || missionSchedule,
  };
}

module.exports = {
  classifyExecutionRequest,
};
