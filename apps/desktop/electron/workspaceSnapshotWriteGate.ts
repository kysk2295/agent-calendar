export type WorkspaceSnapshotWriteClaim = Readonly<{
  sessionId: string;
  generation: number;
}>;

export function createWorkspaceSnapshotWriteGate() {
  let activeSessionId = '';
  let latestGeneration = 0;

  function authorize(currentSessionId: string, claim: WorkspaceSnapshotWriteClaim): boolean {
    if (
      !currentSessionId
      || claim.sessionId !== currentSessionId
      || !Number.isSafeInteger(claim.generation)
      || claim.generation < 1
    ) {
      return false;
    }
    if (activeSessionId !== currentSessionId) {
      activeSessionId = currentSessionId;
      latestGeneration = 0;
    }
    if (claim.generation < latestGeneration) return false;
    latestGeneration = claim.generation;
    return true;
  }

  function reset() {
    activeSessionId = '';
    latestGeneration = 0;
  }

  return { authorize, reset };
}
