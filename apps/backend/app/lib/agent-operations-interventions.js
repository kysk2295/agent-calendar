const { sanitizeSessionEvent, transitionAgentTask } = require('./agent-operations-domain');
const { isUnsupportedExternalRequest } = require('./agent-work-delivery');

class AgentOperationsInterventionError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AgentOperationsInterventionError';
    this.code = code;
    this.status = status;
  }
}

function agentTask(store, taskId) {
  const task = store.getState().tasks.find((item) => (
    item.id === taskId && item.origin === 'agent'
  ));
  if (!task) {
    throw new AgentOperationsInterventionError(
      'task_not_found',
      'Agent task was not found',
      404,
    );
  }
  return task;
}

function sessionMode(taskStatus) {
  if (taskStatus === 'running') return 'next_checkpoint';
  if (['proposed', 'scheduled', 'blocked'].includes(taskStatus)) return 'next_run';
  return 'retry_required';
}

function addAgentSessionMessage({ store, sessionId, input = {}, clock = () => new Date() } = {}) {
  const session = store.getAgentSession(sessionId);
  if (!session) {
    throw new AgentOperationsInterventionError(
      'session_not_found',
      'Task Session was not found',
      404,
    );
  }
  const task = session.taskId ? agentTask(store, session.taskId) : null;
  const text = String(input.text || input.message || '').trim();
  if (!text) {
    throw new AgentOperationsInterventionError(
      'message_invalid',
      'Task Session message is required',
      422,
    );
  }
  if (isUnsupportedExternalRequest(text)) {
    throw new AgentOperationsInterventionError(
      'unsupported_external_request',
      'External side effects are not supported by Task Session messages',
      422,
    );
  }
  const applicationMode = task ? sessionMode(task.status) : 'mission_context';
  const event = sanitizeSessionEvent({
    kind: 'user_message',
    text,
    metadata: {
      applicationMode,
      receivedAt: clock().toISOString(),
    },
  });
  const pendingInstructions = [
    ...(Array.isArray(session.pendingInstructions) ? session.pendingInstructions : []),
    event.text,
  ];
  store.updateAgentSession(session.id, { pendingInstructions });
  const message = store.appendAgentSessionEvent(session.id, event);
  return {
    session: store.getAgentSession(session.id),
    message,
    applicationMode,
  };
}

function transitionRunningTask(store, task, action, clock) {
  const requestedAt = clock().toISOString();
  const patch = action === 'pause'
    ? { pauseRequestedAt: requestedAt, pauseMode: 'next_checkpoint' }
    : { cancelRequestedAt: requestedAt, pauseMode: 'next_checkpoint' };
  const updated = store.updateTask(task.id, patch);
  store.appendAgentSessionEvent(updated.sessionId, sanitizeSessionEvent({
    kind: 'approval_response',
    text: `${action} 요청을 받았습니다. 실행 중인 Hermes 작업의 다음 체크포인트에 적용합니다.`,
    metadata: { action, applicationMode: 'next_checkpoint', requestedAt },
  }));
  return updated;
}

function transitionAgentTaskWithIntervention({
  store,
  taskId,
  action,
  clock = () => new Date(),
} = {}) {
  const task = agentTask(store, taskId);
  if (task.status === 'running' && ['pause', 'cancel'].includes(action)) {
    return transitionRunningTask(store, task, action, clock);
  }
  if (
    action === 'resume'
    && (task.failureCode === 'budget_exhausted' || task.blockedReason === 'budget_exhausted')
  ) {
    throw new AgentOperationsInterventionError(
      'budget_approval_required',
      'Explicit budget approval is required before this task can resume',
      409,
    );
  }
  if (task.failureCode === 'relay_cancel_unconfirmed' && action === 'resume') {
    throw new AgentOperationsInterventionError(
      'relay_cancel_unconfirmed',
      'Remote Hermes cancellation must be confirmed before this task can resume',
      409,
    );
  }

  let transitioned;
  try {
    transitioned = transitionAgentTask(task, action, { clock });
  } catch (error) {
    throw new AgentOperationsInterventionError(
      'invalid_task_transition',
      error.message,
      409,
    );
  }
  const now = clock().toISOString();
  const patch = {
    ...transitioned,
    ...(action === 'retry' ? {
      attempt: Number(task.attempt || 0) + 1,
      retryScheduledAt: now,
      failureCode: '',
      blockedReason: '',
    } : {}),
    ...(['resume', 'retry'].includes(action) ? {
      pauseRequestedAt: '',
      cancelRequestedAt: '',
      pauseMode: '',
    } : {}),
  };
  const updated = store.updateTask(task.id, patch);
  if (updated.sessionId) {
    const sessionStatus = action === 'approve' || action === 'resume' || action === 'retry'
      ? 'scheduled'
      : updated.status;
    store.updateAgentSession(updated.sessionId, { status: sessionStatus });
    store.appendAgentSessionEvent(updated.sessionId, sanitizeSessionEvent({
      kind: 'approval_response',
      text: `${action}: ${task.status} -> ${updated.status}`,
      metadata: { action, previousStatus: task.status, status: updated.status },
    }));
  }
  return updated;
}

module.exports = {
  AgentOperationsInterventionError,
  addAgentSessionMessage,
  transitionAgentTaskWithIntervention,
};
