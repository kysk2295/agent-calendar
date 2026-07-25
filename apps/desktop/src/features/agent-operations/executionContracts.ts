import type {
  AgentDeliverable,
  AgentDeliverableKind,
  AgentExecutionEngine,
} from './types';
import type { AgentResolvedExecutionEngine } from './workConversationTypes';

export const EXECUTION_ENGINE_OPTIONS = [
  { value: 'auto', label: '자동 선택', detail: '작업 종류에 맞춰 선택' },
  { value: 'hermes', label: 'Hermes', detail: '프로필과 도구 사용' },
  { value: 'local_llm', label: '로컬 LLM', detail: 'Runner에 설치된 로컬 모델' },
  { value: 'codex', label: 'Codex', detail: '코드와 파일 작업' },
  { value: 'claude', label: 'Claude', detail: 'Claude Code CLI' },
  { value: 'grok', label: 'Grok', detail: 'Grok CLI' },
] as const satisfies readonly Readonly<{
  value: AgentExecutionEngine;
  label: string;
  detail: string;
}>[];

const RESOLVED_ENGINE_LABELS: Readonly<Record<AgentResolvedExecutionEngine, string>> = {
  hermes: 'Hermes',
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  fake: 'Fake',
};

export const DELIVERABLE_OPTIONS = [
  { value: 'report', label: '보고서' },
  { value: 'document', label: '문서' },
  { value: 'image', label: '이미지' },
  { value: 'file', label: '파일' },
] as const satisfies readonly Readonly<{
  value: AgentDeliverableKind;
  label: string;
}>[];

export const DELIVERABLE_FORMATS: Readonly<Record<AgentDeliverableKind, readonly Readonly<{
  value: string;
  label: string;
}>[]>> = {
  report: [{ value: 'markdown', label: 'Markdown' }],
  document: [
    { value: 'docx', label: 'Word 문서 (.docx)' },
    { value: 'pdf', label: 'PDF' },
    { value: 'markdown', label: 'Markdown' },
  ],
  image: [
    { value: 'png', label: 'PNG' },
    { value: 'webp', label: 'WebP' },
  ],
  file: [
    { value: 'zip', label: 'ZIP' },
    { value: 'source', label: '원본 파일' },
  ],
};

export function executionEngineLabel(engine: AgentExecutionEngine): string {
  return EXECUTION_ENGINE_OPTIONS.find((option) => option.value === engine)?.label || 'Hermes';
}

/** Visible label for the engine that actually ran (requested `auto` is never shown here). */
export function resolvedExecutionEngineLabel(engine: AgentResolvedExecutionEngine): string {
  return RESOLVED_ENGINE_LABELS[engine] || engine;
}

export function deliverableLabel(deliverable: AgentDeliverable): string {
  const kind = DELIVERABLE_OPTIONS.find((option) => option.value === deliverable.kind)?.label || '보고서';
  const format = DELIVERABLE_FORMATS[deliverable.kind].find((option) => option.value === deliverable.format)?.label
    || deliverable.format;
  return format ? `${kind} · ${format}` : kind;
}
