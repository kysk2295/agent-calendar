const REPORT_SCHEMA = {
  title: 'string',
  findings: ['string'],
  evidence: [{ label: 'string', url: 'https://...' }],
  limitations: ['string'],
  followUps: [{ title: 'string', reason: 'string' }],
  budget: { usedRuns: 'number', usedMinutes: 'number' },
};

function resolveExecutionEngine(requestedEngine, deliverable = {}) {
  const requested = String(requestedEngine || 'hermes').trim() || 'hermes';
  if (requested !== 'auto') return requested;
  return deliverable?.kind === 'file' ? 'codex' : 'hermes';
}

function taskExecutionMessages(mission, task, session, priorMissionEvidence = []) {
  const userMessages = session.events
    .filter((event) => event.kind === 'user_message')
    .map((event) => event.text)
    .filter(Boolean);
  const requestedDeliverable = task.deliverable
    || mission.deliverable
    || { kind: 'report', format: 'markdown' };
  return [
    {
      role: 'system',
      content: JSON.stringify({
        instruction: task.actionClass === 'report'
          ? 'Complete one bounded internal Agent Calendar report. Do not perform external side effects. Return JSON only using reportSchema, grounded in priorMissionEvidence, with evidence and limitations.'
          : 'Complete one bounded internal Agent Calendar task. Do not perform external side effects. Return evidence and limitations.',
        mission: {
          title: mission.title,
          objective: mission.objective,
          successCriteria: mission.successCriteria,
          forbiddenActions: mission.policy?.forbiddenActions || [],
        },
        requestedDeliverable,
        artifactRule: 'Produce the requested deliverable when the runtime supports it. Never claim that a file exists unless the final output includes a real accessible artifact reference.',
        ...(task.actionClass === 'report' ? { reportSchema: REPORT_SCHEMA } : {}),
      }),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: {
          title: task.title,
          reason: task.reason,
          expectedOutput: task.expectedOutput,
          actionClass: task.actionClass,
          sourceRefs: task.sourceRefs,
          dueAt: task.dueAt,
          executionEngine: task.executionEngine || mission.executionEngine || 'hermes',
          deliverable: requestedDeliverable,
        },
        userMessages,
        priorMissionEvidence,
      }),
    },
  ];
}

module.exports = {
  resolveExecutionEngine,
  taskExecutionMessages,
};
