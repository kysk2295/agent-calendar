const REPORT_SCHEMA = {
  title: 'string',
  findings: ['string'],
  evidence: [{ label: 'string', url: 'https://...' }],
  limitations: ['string'],
  followUps: [{ title: 'string', reason: 'string' }],
  budget: { usedRuns: 'number', usedMinutes: 'number' },
};

function taskExecutionMessages(mission, task, session, priorMissionEvidence = []) {
  const userMessages = session.events
    .filter((event) => event.kind === 'user_message')
    .map((event) => event.text)
    .filter(Boolean);
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
        },
        userMessages,
        priorMissionEvidence,
      }),
    },
  ];
}

module.exports = {
  taskExecutionMessages,
};
