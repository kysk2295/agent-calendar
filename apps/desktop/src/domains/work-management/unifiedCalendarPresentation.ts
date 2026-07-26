/**
 * Phase 4: map Unified Calendar API entries into Desktop calendar event records.
 */

export type UnifiedCoverage = Readonly<{
  sourceId: string;
  sourceKind?: string;
  provider?: string;
  label?: string;
  state: string;
  message?: string;
  eventCount?: number;
  lastSyncedAt?: string | null;
}>;

export type UnifiedCalendarEntry = Readonly<{
  id: string;
  entryId?: string;
  sourceId: string;
  sourceKind: string;
  provider: string;
  sourceLabel?: string;
  providerEventId?: string;
  title: string;
  allDay?: boolean;
  startsAt: string;
  endsAt: string;
  timezone?: string;
  writable?: boolean;
  etag?: string;
  freshness?: string | null;
  status?: string;
  lifecycleStatus?: string;
}>;

type SourceAwareCalendarEntry = Readonly<{
  sourceKind?: string;
  provider?: string;
  sourceLabel?: string;
}>;

export function coverageSummary(coverage: readonly UnifiedCoverage[] = []): string {
  if (!coverage.length) return '소스 없음';
  const incomplete = coverage.filter((c) => c.state === 'unsynchronized' || c.state === 'incomplete' || c.state === 'stale' || c.state === 'error');
  if (incomplete.length) {
    return `커버리지 불완전 · ${incomplete.map((c) => c.label || c.sourceId).join(', ')}`;
  }
  return `커버리지 완료 · 소스 ${coverage.length}`;
}

export function sourceBadge(entry: SourceAwareCalendarEntry): string {
  if (entry.sourceKind === 'agent_work' || entry.provider === 'agent_work') return 'Agent';
  if (entry.provider === 'google') return 'Google';
  if (entry.sourceKind === 'internal' || entry.provider === 'internal') return 'Internal';
  return entry.sourceLabel || entry.provider || 'Source';
}

export function monthSourceBadge(entry: SourceAwareCalendarEntry): string {
  const badge = sourceBadge(entry);
  return badge === 'Internal' ? '' : badge;
}

function agentLifecycleLabel(status: string): string {
  if (status === 'scheduled') return '예정';
  if (status === 'running') return '진행';
  if (status === 'completed') return '완료';
  if (status === 'rework') return '재작업';
  if (status === 'failed') return '실패';
  if (status === 'cancelled') return '취소';
  return status;
}

/** Map unified entries into legacy calendar event shape used by App hydrate. */
export function mapUnifiedEntriesToCalendarEvents(entries: readonly UnifiedCalendarEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    const startsAt = entry.startsAt;
    const date = String(startsAt).slice(0, 10);
    // Prefer local wall-clock slice; fall back to ISO time for UTC Z strings.
    const timeMatch = String(startsAt).match(/T(\d{2}):(\d{2})/);
    const time = entry.allDay ? '' : (timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : String(startsAt).slice(11, 16));
    const isExternal = entry.sourceKind === 'external_calendar' || entry.provider === 'google';
    const isAgent = entry.sourceKind === 'agent_work' || entry.provider === 'agent_work';
    const lifecycleStatus = isAgent ? (entry.lifecycleStatus || entry.status || 'scheduled') : '';
    return {
      id: entry.entryId || entry.id,
      kind: 'calendar-event',
      type: 'calendar-event',
      title: entry.title,
      startsAt,
      endsAt: entry.endsAt,
      date,
      startDate: date,
      time,
      allDay: Boolean(entry.allDay),
      source: isAgent ? 'agent-work' : entry.provider,
      sourceId: entry.sourceId,
      sourceLabel: entry.sourceLabel || sourceBadge(entry),
      sourceKind: entry.sourceKind,
      providerEventId: entry.providerEventId || entry.entryId || '',
      writable: entry.writable !== false && !isAgent,
      isExternal,
      etag: entry.etag || '',
      freshness: entry.freshness || null,
      timezone: entry.timezone || 'UTC',
      unifiedId: entry.id,
      origin: isAgent ? 'agent' : undefined,
      status: lifecycleStatus || entry.status || '',
      lifecycleStatus,
      agentTaskState: lifecycleStatus,
      agentTaskLabel: lifecycleStatus ? agentLifecycleLabel(lifecycleStatus) : '',
    };
  });
}

export function isExternalWritableEvent(item: { sourceKind?: string; provider?: string; source?: string; writable?: boolean } | null | undefined): boolean {
  if (!item) return false;
  const external = item.sourceKind === 'external_calendar'
    || item.provider === 'google'
    || item.source === 'google';
  return external && item.writable !== false;
}

export function isReadOnlyCalendarEntry(item: { sourceKind?: string; provider?: string; source?: string; writable?: boolean; origin?: string } | null | undefined): boolean {
  if (!item) return false;
  if (item.writable === false) return true;
  if (item.origin === 'agent' || item.sourceKind === 'agent_work' || item.provider === 'agent_work' || item.source === 'agent-work') return true;
  return false;
}
