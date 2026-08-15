import type {
  AgentAssignment,
  AgentWorkApplicationMode,
  AgentWorkCheckpointApplicationMode,
  AgentWorkDeliveryStatus,
  AgentWorkChannelEndpoint,
} from './workConversationTypes';
import type { AgentDeliverableKind } from './types';

function unreachable(value: never): never {
  throw new Error(`Unreachable Agent Work variant: ${String(value)}`);
}

export function telegramIngressOwnershipLabel(
  ownership: AgentWorkChannelEndpoint['ingressOwnership'],
): string {
  switch (ownership) {
    case 'unverified': return '수신 소유권 미확인';
    case 'owned': return '수신 확인됨';
    case 'conflict': return '다른 수신 주체와 충돌';
    default: return unreachable(ownership);
  }
}

export function telegramIngressReadinessLabel(
  readiness: AgentWorkChannelEndpoint['ingressReadiness'],
  endpointStatus: AgentWorkChannelEndpoint['status'],
  runnerConnected: boolean,
): string {
  if (endpointStatus === 'revoked') return 'Telegram 다시 설정 필요';
  if (endpointStatus === 'offline') return 'Telegram 연결 필요';
  switch (readiness) {
    case 'unverified': return '확인 전';
    case 'ready': return runnerConnected ? '수신 준비됨' : 'Runner 연결 필요';
    case 'conflict': return '수신 주체 전환 필요';
    case 'stale': return '다시 확인 필요';
    default: return unreachable(readiness);
  }
}

export function wikiArchiveStatusLabel(status: 'pending_local' | 'written' | 'skipped_no_wiki' | 'failed' | string): string {
  switch (status) {
    case 'pending_local': return '폴더 미연결 · 보관 대기';
    case 'written': return '위키에 보관됨';
    case 'skipped_no_wiki': return '위키 미설정 · 보관 생략';
    case 'failed': return '위키 보관 실패';
    default: return '위키 보관 상태 확인 중';
  }
}

export function deliveryStatusLabel(status: AgentWorkDeliveryStatus): string {
  switch (status) {
    case 'accepted': return '접수됨';
    case 'applied': return '적용됨';
    case 'queued': return '다음 시도에 반영 예정';
    case 'approval_required': return '승인 필요';
    case 'rejected': return '실행할 수 없음';
    default: return unreachable(status);
  }
}

export function deliveryApplicationLabel(mode: AgentWorkApplicationMode): string {
  switch (mode) {
    case 'mission_context': return '작업 대화에 저장';
    case 'next_attempt': return '다음 시도';
    case 'next_checkpoint': return '다음 체크포인트';
    case 'state_transition': return '작업 상태 변경';
    case 'unsupported_external_request': return '지원되지 않는 외부 작업';
    case 'revision': return '수정 차수';
    case 'follow_up_required': return '별도 후속 작업 필요';
    default: return unreachable(mode);
  }
}

export function checkpointApplicationLabel(mode: AgentWorkCheckpointApplicationMode): string {
  switch (mode) {
    case 'checkpoint_result': return '체크포인트 결과';
    case 'applied_at_checkpoint': return '체크포인트에서 적용';
    default: return deliveryApplicationLabel(mode);
  }
}

export function deliveryCopy(status: AgentWorkDeliveryStatus, mode: AgentWorkCheckpointApplicationMode): string {
  if (status === 'accepted' && mode === 'next_checkpoint') {
    return '다음 체크포인트 적용 요청됨. 실행 중인 단계가 끝난 뒤 반영됩니다.';
  }
  if (mode === 'follow_up_required') {
    return `${deliveryStatusLabel(status)} · ${checkpointApplicationLabel(mode)}. 다른 목표는 새 작업으로 위임해 주세요.`;
  }
  switch (status) {
    case 'accepted': return `접수됨 · ${checkpointApplicationLabel(mode)}. 작업 대화에 저장되었습니다.`;
    case 'applied': return `적용됨 · ${checkpointApplicationLabel(mode)}. 작업 상태에 반영되었습니다.`;
    case 'queued': return '다음 시도에 반영 예정 — 현재 실행은 중단하지 않습니다.';
    case 'approval_required': return '승인 필요. 승인 전에는 실행되지 않습니다.';
    case 'rejected': return `실행할 수 없음 · ${checkpointApplicationLabel(mode)}. 아무 작업도 수행하지 않았습니다.`;
    default: return unreachable(status);
  }
}

export function responsibleAgentLabel(assignment: AgentAssignment): string {
  switch (assignment.kind) {
    case 'explicit': return `직접 지정 · ${assignment.agentId}`;
    case 'keyword': return `자동 배정 · ${assignment.agentId}`;
    case 'default': return `기본 담당 · ${assignment.agentId}`;
    case 'legacy': return `기존 작업 · ${assignment.agentId}`;
    default: return unreachable(assignment);
  }
}

export function responsibleAgentAssignmentCopy(assignment: AgentAssignment): string {
  switch (assignment.kind) {
    case 'explicit': return '직접 지정 · 사용자가 담당 에이전트를 선택했습니다.';
    case 'keyword': return '자동 배정 · 작업 요청의 전문 분야와 일치합니다.';
    case 'default': return '기본 배정 · 별도 지정 없이 기본 담당자가 배정되었습니다.';
    case 'legacy': return '배정 기록 없음 · 기존 작업이라 배정 이유를 확인할 수 없습니다.';
    default: return unreachable(assignment);
  }
}

export function deliverableKindLabel(kind: AgentDeliverableKind): string {
  switch (kind) {
    case 'report': return '보고서';
    case 'document': return '문서';
    case 'image': return '이미지';
    case 'file': return '파일';
    default: return unreachable(kind);
  }
}

export function deliverableFormatLabel(format: string): string {
  switch (format.trim().toLowerCase()) {
    case '':
    case 'auto': return '자동';
    case 'docx': return 'Word 문서';
    case 'md':
    case 'markdown': return 'Markdown';
    case 'pdf': return 'PDF';
    case 'txt': return '텍스트';
    default: return format;
  }
}

export function preserveWorkClosingPhrase(text: string): string {
  return text.split('\n').map((line) => {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return line;
    const closingTokens = tokens.slice(-Math.min(4, tokens.length));
    const closing = closingTokens.join('');
    const leading = line.match(/^\s*/)?.[0] || '';
    const trailing = line.match(/\s*$/)?.[0] || '';
    const prefix = tokens.slice(0, -closingTokens.length);
    const readableClosing = closing.length <= 22 && /[가-힣]/.test(closing)
      ? `${prefix.length ? `${prefix.join(' ')} ` : ''}${closingTokens.join('\u00a0')}`
      : tokens.join(' ');
    const readablePhrase = readableClosing.replace(
      /(^|[ \t])(이|그|저)\s+([가-힣]+의)\s+([가-힣]+(?:을|를|은|는|이|가))(?=\s|[.,:!?]|$)/g,
      (_match, boundary: string, demonstrative: string, owner: string, object: string) => `${boundary}${demonstrative}\u00a0${owner}\u00a0${object}`,
    );
    return `${leading}${readablePhrase}${trailing}`;
  }).join('\n');
}
