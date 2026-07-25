import type {
  AutomationCapabilities,
  AutomationChangeReceipt,
  ConnectedAutomationSource,
  HermesAutomationJob,
  HermesAutomationStatus,
} from './types';

type UnknownRecord = Readonly<Record<string, unknown>>;

function recordValue(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function firstText(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function normalizedStatus(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function booleanCapability(record: UnknownRecord | null, key: keyof AutomationCapabilities): boolean {
  return record?.[key] === true;
}

function automationCapabilities(value: unknown): AutomationCapabilities {
  const record = recordValue(value);
  return {
    list: booleanCapability(record, 'list'),
    create: booleanCapability(record, 'create'),
    update: booleanCapability(record, 'update'),
    pause: booleanCapability(record, 'pause'),
    resume: booleanCapability(record, 'resume'),
    run: booleanCapability(record, 'run'),
    delete: booleanCapability(record, 'delete'),
  };
}

function automationReceipt(value: unknown): AutomationChangeReceipt | null {
  const record = recordValue(value);
  if (!record) return null;
  const rawStatus = firstText(record['status']);
  const status = ['succeeded', 'failed', 'unknown', 'conflict'].includes(rawStatus)
    ? rawStatus as AutomationChangeReceipt['status']
    : 'unknown';
  return {
    id: firstText(record['id']),
    status,
    operation: firstText(record['operation']),
    sourceRevision: firstText(record['sourceRevision'], record['source_revision']),
    errorCode: firstText(record['errorCode'], record['error_code']),
    errorMessage: firstText(record['errorMessage'], record['error_message']),
    createdAt: firstText(record['createdAt'], record['created_at']),
  };
}

export function parseConnectedAutomationSources(
  records: readonly unknown[],
): readonly ConnectedAutomationSource[] {
  return records.flatMap((candidate) => {
    const record = recordValue(candidate);
    if (!record) return [];
    const id = firstText(record['id']);
    const rawStatus = firstText(record['status']);
    if (!id) return [];
    return [{
      id,
      runnerId: firstText(record['runnerId'], record['runner_id']),
      adapterKind: firstText(record['adapterKind'], record['adapter_kind']),
      displayName: firstText(record['displayName'], record['display_name']) || '자동화 소스',
      status: ['connected', 'disconnected', 'stale', 'error'].includes(rawStatus)
        ? rawStatus as ConnectedAutomationSource['status']
        : 'error',
      capabilities: automationCapabilities(record['capabilities']),
      lastSyncedAt: firstText(record['lastSyncedAt'], record['last_synced_at']),
      staleAfter: firstText(record['staleAfter'], record['stale_after']),
    }];
  });
}

export function parseConnectedAutomations(records: readonly unknown[]): readonly HermesAutomationJob[] {
  return records.flatMap((candidate, index) => {
    const record = recordValue(candidate);
    if (!record) return [];
    const sourceRecord = recordValue(record['source']);
    const rawStatus = firstText(record['status']);
    const explicitEnabled = typeof record['enabled'] === 'boolean' ? record['enabled'] : null;
    const status = automationStatus(rawStatus, explicitEnabled);
    const projection = recordValue(record['projection']);
    return [{
      id: firstText(record['id']) || `connected-automation-${index + 1}`,
      sourceId: firstText(record['sourceId'], record['source_id'], sourceRecord?.['id']),
      externalId: firstText(record['externalId'], record['external_id']),
      name: firstText(record['name']) || '이름 없는 자동화',
      description: firstText(record['goal'], record['description']),
      agentId: firstText(record['agentId'], record['agent_id']) || '확인 필요',
      schedule: firstText(record['schedule']) || '일정 확인 필요',
      status,
      enabled: explicitEnabled,
      source: firstText(sourceRecord?.['displayName'], sourceRecord?.['display_name']) || '자동화 소스',
      sourceStatus: firstText(sourceRecord?.['status']),
      sourceRevision: firstText(record['sourceRevision'], record['source_revision']),
      capabilities: automationCapabilities(record['capabilities']),
      lastReceipt: automationReceipt(record['lastReceipt']),
      lastSyncedAt: firstText(record['lastSyncedAt'], record['last_synced_at']),
      staleAfter: firstText(record['staleAfter'], record['stale_after']),
      lastRunAt: firstText(projection?.['lastRunAt'], projection?.['lastRun']),
      nextRunAt: firstText(projection?.['nextRunAt'], projection?.['nextRun']),
      lastStatus: firstText(projection?.['lastStatus'], projection?.['lastResult'], rawStatus),
    }];
  });
}

function automationStatus(rawStatus: string, enabled: boolean | null): HermesAutomationStatus {
  const status = normalizedStatus(rawStatus);
  if (enabled === false || ['paused', 'disabled', 'stopped', 'inactive', '일시정지'].includes(status)) return 'paused';
  if (['failed', 'error', 'blocked', '실패', '오류'].includes(status)) return 'failed';
  if (['active', 'running', 'enabled', 'scheduled', 'ready', 'ok', 'online', '활성', '실행 중'].includes(status)) return 'active';
  if (!status && enabled === true) return 'active';
  return 'unknown';
}

export function parseHermesAutomationJobs(records: readonly unknown[]): readonly HermesAutomationJob[] {
  return records.flatMap((candidate, index) => {
    const record = recordValue(candidate);
    if (!record) return [];
    const payload = recordValue(record['payload']);
    const scheduleRecord = recordValue(record['schedule']);
    const rawStatus = firstText(record['status'], record['state'], record['lastStatus']);
    const explicitEnabled = typeof record['enabled'] === 'boolean' ? record['enabled'] : null;
    const status = automationStatus(rawStatus, explicitEnabled);
    const enabled = explicitEnabled ?? (status === 'active' ? true : status === 'paused' ? false : null);
    const schedule = typeof record['schedule'] === 'string'
      ? record['schedule'].trim()
      : firstText(
        record['scheduleDisplay'],
        record['schedule_display'],
        record['cron'],
        record['cronExpression'],
        record['cadence'],
        scheduleRecord?.['display'],
        scheduleRecord?.['label'],
        scheduleRecord?.['human'],
        scheduleRecord?.['cron'],
      );

    return [{
      id: firstText(record['id'], record['_id'], record['key']) || `hermes-automation-${index + 1}`,
      sourceId: '',
      externalId: firstText(record['id'], record['_id'], record['key']),
      name: firstText(record['name'], record['title'], record['label']) || '이름 없는 Hermes 자동화',
      description: firstText(record['goal'], record['description'], record['objective'], record['prompt'], payload?.['goal'], payload?.['objective'], payload?.['prompt']),
      agentId: firstText(record['agentId'], record['agent'], record['profile'], record['profileId'], payload?.['agentId'], payload?.['profile']) || '확인 필요',
      schedule: schedule || '일정 확인 필요',
      status,
      enabled,
      source: firstText(record['source'], record['runtime'], payload?.['source']),
      sourceStatus: '',
      sourceRevision: firstText(record['revision'], record['etag']),
      capabilities: {
        list: true,
        create: true,
        update: true,
        pause: true,
        resume: true,
        run: true,
        delete: true,
      },
      lastReceipt: null,
      lastSyncedAt: firstText(record['lastSyncedAt'], record['updatedAt']),
      staleAfter: '',
      lastRunAt: firstText(record['lastRunAt'], record['lastRun'], record['lastExecutedAt']),
      nextRunAt: firstText(record['nextRunAt'], record['nextRun'], record['scheduledAt']),
      lastStatus: firstText(record['lastStatus'], record['lastResult'], record['status']),
    }];
  });
}

export function hermesAutomationStatusLabel(status: HermesAutomationStatus): string {
  switch (status) {
    case 'active': return '활성';
    case 'paused': return '일시정지';
    case 'failed': return '실패';
    case 'unknown': return '확인 필요';
  }
}

export function hermesAutomationLastStatusLabel(status: string): string {
  const value = normalizedStatus(status);
  if (['completed', 'success', 'succeeded', 'done', 'ok', '완료', '성공'].includes(value)) return '정상 완료';
  if (['failed', 'error', 'blocked', '실패', '오류'].includes(value)) return '실패';
  if (['paused', 'disabled', 'stopped', '일시정지'].includes(value)) return '일시정지';
  if (['running', 'active', '실행 중'].includes(value)) return '실행 중';
  if (['scheduled', 'queued', '예약', '예약됨'].includes(value)) return '예약됨';
  return '상태 확인 필요';
}

export function hermesAutomationRuntimeLabel(source: string): string {
  const value = source.trim().toLocaleLowerCase('en-US');
  if (value.includes('hermes')) return 'Hermes Runner';
  if (value.includes('scheduler') || value.includes('gateway')) return 'Scheduler gateway';
  return source || '실행 위치 확인 필요';
}
