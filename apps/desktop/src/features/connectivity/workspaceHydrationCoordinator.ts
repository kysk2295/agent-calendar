export type WorkspaceSessionLease = Readonly<{
  sessionId: string;
  epoch: number;
}>;

export type WorkspaceHydrationTicket = WorkspaceSessionLease & Readonly<{
  generation: number;
}>;

export function createWorkspaceHydrationCoordinator() {
  let epoch = 0;
  let generation = 0;
  let sessionId = '';
  let previousSessionId = '';

  function activateSession(nextSessionId: string): WorkspaceSessionLease {
    epoch += 1;
    if (nextSessionId !== previousSessionId) generation = 0;
    sessionId = nextSessionId;
    previousSessionId = nextSessionId;
    return { sessionId, epoch };
  }

  function beginSessionTransition() {
    epoch += 1;
    sessionId = '';
  }

  function clearSession() {
    epoch += 1;
    generation = 0;
    sessionId = '';
    previousSessionId = '';
  }

  function isSessionCurrent(session: WorkspaceSessionLease): boolean {
    return Boolean(
      session.sessionId
      && session.sessionId === sessionId
      && session.epoch === epoch,
    );
  }

  function beginHydration(session: WorkspaceSessionLease): WorkspaceHydrationTicket | null {
    if (!isSessionCurrent(session)) return null;
    generation += 1;
    return { ...session, generation };
  }

  function beginCurrentHydration(): WorkspaceHydrationTicket | null {
    if (!sessionId) return null;
    return beginHydration({ sessionId, epoch });
  }

  function isCurrent(ticket: WorkspaceHydrationTicket): boolean {
    return isSessionCurrent(ticket) && ticket.generation === generation;
  }

  function commitIfCurrent(ticket: WorkspaceHydrationTicket, commit: () => void): boolean {
    if (!isCurrent(ticket)) return false;
    commit();
    return true;
  }

  return {
    activateSession,
    beginSessionTransition,
    clearSession,
    isSessionCurrent,
    beginHydration,
    beginCurrentHydration,
    isCurrent,
    commitIfCurrent,
  };
}

export type WorkspaceHydrationCoordinator = ReturnType<typeof createWorkspaceHydrationCoordinator>;
