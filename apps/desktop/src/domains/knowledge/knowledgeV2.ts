type UnknownRecord = Record<string, unknown>;

export type KnowledgeV2Presentation = {
  answer: string;
  sources: UnknownRecord[];
  meta: UnknownRecord;
  jobId: string;
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function evidenceList(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = record(item);
    return {
      handle: stringValue(source.handle || source.id),
      title: stringValue(source.title || source.citationLabel) || '근거',
      excerpt: stringValue(source.excerpt),
      sourceId: stringValue(source.sourceId),
    };
  });
}

export function parseKnowledgeV2Answer(payload: unknown): KnowledgeV2Presentation {
  const envelope = record(payload);
  const privateLocal = record(envelope.privateLocal);
  const answerStatus = stringValue(envelope.answerStatus) || 'error';
  let answer = stringValue(envelope.answer || envelope.text);
  if (answerStatus === 'pending') {
    answer = 'Runner에서 로컬 지식을 검색하고 있습니다.';
  } else if (answerStatus === 'runner_required') {
    answer = '로컬 지식을 검색하려면 이 Workspace의 Runner를 연결해 주세요.';
  } else if (answerStatus === 'empty') {
    answer = '현재 Workspace 지식에서 답을 찾지 못했습니다.';
  }
  return {
    answer,
    sources: evidenceList(
      Array.isArray(envelope.citations) ? envelope.citations : envelope.results,
    ),
    meta: {
      provider: 'Knowledge v2',
      mode: stringValue(envelope.mode) || 'knowledge_v2',
      answerStatus,
      code: stringValue(envelope.code),
      privateLocalStatus: stringValue(privateLocal.status),
    },
    jobId: stringValue(envelope.jobId || privateLocal.jobId),
  };
}

export function parseKnowledgeV2Job(payload: unknown): KnowledgeV2Presentation {
  const envelope = record(payload);
  const status = stringValue(envelope.status);
  const sources = evidenceList(envelope.results);
  let answer = '';
  let answerStatus = status;
  if (status === 'completed') {
    answerStatus = sources.length ? 'ok' : 'empty';
    answer = sources.length
      ? sources.map((source) => stringValue(source.excerpt || source.title)).filter(Boolean).join('\n\n')
      : '현재 연결된 지식에서 답을 찾지 못했습니다.';
  } else if (status === 'failed') {
    answer = stringValue(envelope.message) || 'Runner 지식 검색에 실패했습니다.';
  } else {
    answer = 'Runner에서 로컬 지식을 검색하고 있습니다.';
    answerStatus = 'pending';
  }
  return {
    answer,
    sources,
    meta: {
      provider: 'Knowledge v2',
      mode: 'knowledge_v2',
      answerStatus,
      code: stringValue(envelope.code),
      privateLocalStatus: status,
    },
    jobId: stringValue(envelope.jobId),
  };
}

export function knowledgeSourceStatusLabel(sourceValue: unknown): string {
  const source = record(sourceValue);
  const status = stringValue(source.status).toLowerCase();
  if (status === 'revoked') return '연결 해제됨';
  if (status === 'runner_required') return 'Runner 연결 필요';
  if (status === 'error' || status === 'failed') return '오류';
  if (status === 'ready' || status === 'active') return '사용 가능';
  return status || '확인 필요';
}

export function knowledgeSourceKindLabel(sourceValue: unknown): string {
  const source = record(sourceValue);
  const kind = stringValue(source.sourceKind || source.source_kind).toLowerCase();
  if (kind === 'cloud_indexed') return '암호화 색인';
  if (kind === 'private_local') return 'Runner 로컬';
  if (kind === 'legacy_wiki') return '기존 Wiki';
  return '지식 소스';
}
