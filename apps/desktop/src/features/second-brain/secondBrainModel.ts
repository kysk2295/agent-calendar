export type SecondBrainDecision = Readonly<{
  claimId: string;
  action: 'confirm' | 'correct' | 'reject';
  text?: string;
  basis: string;
}>;
export type SecondBrainReviewDraft = Readonly<Record<string, SecondBrainDecision>>;

export function stageSecondBrainDecision(
  draft: SecondBrainReviewDraft,
  claimId: string,
  action: SecondBrainDecision['action'],
  textValue = '',
): SecondBrainReviewDraft {
  return {
    ...draft,
    [claimId]: {
      claimId,
      action,
      ...(action === 'correct' ? { text: textValue } : {}),
      basis: action === 'confirm' ? '사용자 확인' : action === 'correct' ? '사용자 수정' : '사용자 제외',
    },
  };
}

export function updateStagedCorrection(
  draft: SecondBrainReviewDraft,
  claimId: string,
  textValue: string,
): SecondBrainReviewDraft {
  const selected = draft[claimId];
  if (!selected || selected.action !== 'correct') return draft;
  return { ...draft, [claimId]: { ...selected, text: textValue } };
}

export type SecondBrainClaim = Readonly<{
  id: string;
  text: string;
  provenance: Readonly<Record<string, unknown>>;
  citation: string;
}>;

export type SecondBrainSnapshot = Readonly<{
  id: string;
  version: number;
  status: string;
  claims: readonly SecondBrainClaim[];
}>;

export type SecondBrainRun = Readonly<{
  id: string;
  status: string;
  stage: string;
  processed: number;
  total: number;
  sourceIds: readonly string[];
  snapshot: SecondBrainSnapshot | null;
  error: Readonly<{ code: string; message: string }> | null;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nonnegative(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

export function parseSecondBrainSnapshot(value: unknown): SecondBrainSnapshot | null {
  const source = record(value);
  const id = text(source.id);
  if (!id) return null;
  const claims = (Array.isArray(source.claims) ? source.claims : [])
    .map((item): SecondBrainClaim | null => {
      const claim = record(item);
      const provenance = record(claim.provenance);
      const citation = text(claim.citation);
      if (!text(claim.id) || !Object.keys(provenance).length || !citation) return null;
      return { id: text(claim.id), text: text(claim.text), provenance, citation };
    })
    .filter((claim): claim is SecondBrainClaim => claim !== null);
  return {
    id,
    version: Math.max(1, Math.floor(nonnegative(source.version))),
    status: text(source.status) || 'ready_for_review',
    claims,
  };
}

export function parseSecondBrainRun(value: unknown, snapshotValue?: unknown): SecondBrainRun | null {
  const source = record(value);
  const id = text(source.id);
  if (!id) return null;
  const error = record(source.error);
  return {
    id,
    status: text(source.status) || 'source_required',
    stage: text(source.stage) || 'source_required',
    processed: nonnegative(source.processed),
    total: nonnegative(source.total),
    sourceIds: Array.isArray(source.sourceIds) ? source.sourceIds.map(text).filter(Boolean) : [],
    snapshot: parseSecondBrainSnapshot(snapshotValue ?? source.snapshot),
    error: text(error.code) ? { code: text(error.code), message: text(error.message) } : null,
  };
}

export const secondBrainStageLabel = (stage: string) => ({
  collecting: '원본 자료 확인',
  indexing: '자료 색인',
  extracting: '근거 추출',
  linking: '관계 연결',
  ready_for_review: '사용자 검토 대기',
  active: '활성화 완료',
}[stage] || '준비 상태 확인');
