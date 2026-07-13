function taskExecutionMessages(mission, task, session) {
  const userMessages = session.events
    .filter((event) => event.kind === 'user_message')
    .map((event) => event.text)
    .filter(Boolean);
  return [
    {
      role: 'system',
      content: JSON.stringify({
        instruction: 'Complete one bounded internal Agent Calendar task. Do not perform external side effects. Return evidence and limitations.',
        mission: {
          title: mission.title,
          objective: mission.objective,
          successCriteria: mission.successCriteria,
          forbiddenActions: mission.policy?.forbiddenActions || [],
        },
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
      }),
    },
  ];
}

module.exports = {
  taskExecutionMessages,
};
