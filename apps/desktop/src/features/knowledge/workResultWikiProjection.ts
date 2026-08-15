export type PendingWorkResultWikiProjection = Readonly<{
  status: 'pending_local';
  workResultId: string;
  projectionId: string;
  relativePath: string;
  markdown: string;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function pendingWorkResultWikiProjections(
  entries: readonly unknown[],
): readonly PendingWorkResultWikiProjection[] {
  const projections: PendingWorkResultWikiProjection[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = record(value);
    if (text(entry.sourceKind) !== 'agent_work' || text(entry.status) !== 'completed') continue;
    const workResultId = text(entry.workResultId);
    if (!/^work_result_[a-f0-9]{28}$/.test(workResultId) || seen.has(workResultId)) continue;
    const wiki = record(record(entry.result).wiki);
    const projectionId = text(wiki.projectionId);
    const relativePath = text(wiki.relativePath).replace(/\\/g, '/');
    const markdown = typeof wiki.markdown === 'string' ? wiki.markdown : '';
    if (wiki.status !== 'pending_local'
      || projectionId !== `work-result-wiki:${workResultId}`
      || relativePath !== `5_conversation/agent-runs/${workResultId}.md`
      || !markdown) continue;
    seen.add(workResultId);
    projections.push({
      status: 'pending_local',
      workResultId,
      projectionId,
      relativePath,
      markdown,
    });
  }
  return projections;
}
