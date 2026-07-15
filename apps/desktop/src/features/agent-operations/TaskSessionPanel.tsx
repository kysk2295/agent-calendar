import { useEffect, useState } from 'react';

import { agentTaskAppearance } from './agentTaskAppearance';
import { deliverableLabel, executionEngineLabel } from './executionContracts';
import { safeEvidenceHref } from './workResultPresentation';
import type {
  AgentMission,
  AgentSession,
  AgentSessionDetail,
  AgentSessionEvent,
  AgentTask,
  AgentTaskAction,
} from './types';

type TaskSessionPanelProps = {
  readonly detail: AgentSessionDetail;
  readonly sessions: readonly AgentSession[];
  readonly task: AgentTask | undefined;
  readonly mission: AgentMission | undefined;
  readonly busy: string;
  readonly sending: boolean;
  readonly onClose: () => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onSendMessage: (text: string) => Promise<boolean>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
};

type AgentResult = {
  readonly title: string;
  readonly findings: readonly string[];
  readonly evidence: readonly Readonly<{ label: string; url: string }>[];
  readonly limitations: readonly string[];
  readonly followUps: readonly Readonly<{ title: string; reason: string }>[];
};

const EVENT_LABELS: Readonly<Record<AgentSessionEvent['kind'], string>> = {
  agent_message: '에이전트',
  user_message: '나',
  plan: '계획',
  tool_activity: '도구',
  progress: '진행',
  approval_request: '승인 요청',
  approval_response: '개입',
  artifact: '산출물',
  error: '오류',
  completion: '완료',
};

function sessionTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function taskActions(task: AgentTask | undefined): readonly AgentTaskAction[] {
  if (!task) return [];
  switch (task.status) {
    case 'proposed': return ['approve', 'cancel'];
    case 'scheduled':
    case 'running': return ['pause', 'cancel'];
    case 'blocked': return ['resume', 'cancel'];
    case 'failed': return ['retry'];
    case 'approved':
    case 'completed':
    case 'cancelled': return [];
    default: return assertNever(task.status);
  }
}

function actionLabel(action: AgentTaskAction): string {
  const labels: Readonly<Record<AgentTaskAction, string>> = {
    approve: '승인',
    pause: '일시정지',
    resume: '재개',
    cancel: '취소',
    retry: '재시도',
  };
  return labels[action];
}

function eventLink(event: AgentSessionEvent): string {
  const value = event.metadata.url;
  return typeof value === 'string' && /^https?:\/\//.test(value) ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseAgentResult(event: AgentSessionEvent): AgentResult | null {
  if (event.kind !== 'agent_message') return null;
  const source = event.text.trim();
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const payload = (fenced?.[1] || source).trim();
  if (!payload.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(payload);
    if (!isRecord(value)) return null;
    const findings = stringList(value.findings);
    const limitations = stringList(value.limitations);
    const evidence = Array.isArray(value.evidence)
      ? value.evidence.flatMap((item) => isRecord(item) && typeof item.label === 'string' && typeof item.url === 'string' && /^https?:\/\//.test(item.url)
        ? [{ label: item.label, url: item.url }]
        : [])
      : [];
    const followUps = Array.isArray(value.followUps)
      ? value.followUps.flatMap((item) => isRecord(item) && typeof item.title === 'string'
        ? [{ title: item.title, reason: typeof item.reason === 'string' ? item.reason : '' }]
        : [])
      : [];
    if (!findings.length && !evidence.length && !limitations.length && !followUps.length) return null;
    return {
      title: typeof value.title === 'string' && value.title.trim() ? value.title : '에이전트 작업 결과',
      findings,
      evidence,
      limitations,
      followUps,
    };
  } catch {
    return null;
  }
}

function AgentResultView({ result }: Readonly<{ result: AgentResult }>) {
  return (
    <div className="task-session-result">
      <h3>{result.title}</h3>
      {!!result.findings.length && <section><strong>핵심 결과</strong><ul>{result.findings.map((finding, index) => <li key={`${index}-${finding}`}>{finding}</li>)}</ul></section>}
      {!!result.evidence.length && <section><strong>근거</strong><div className="task-session-result-links">{result.evidence.map((evidence, index) => { const href = safeEvidenceHref(evidence.url); return href ? <a href={href} target="_blank" rel="noopener noreferrer" key={`${index}-${evidence.label}-${evidence.url}`}>{evidence.label}</a> : <span key={`${index}-${evidence.label}-${evidence.url}`}>{evidence.label}</span>; })}</div></section>}
      {!!result.limitations.length && <section><strong>한계</strong><ul>{result.limitations.map((limitation, index) => <li key={`${index}-${limitation}`}>{limitation}</li>)}</ul></section>}
      {!!result.followUps.length && <section><strong>다음 작업</strong><div className="task-session-result-followups">{result.followUps.map((followUp, index) => <div key={`${index}-${followUp.title}-${followUp.reason}`}><b>{followUp.title}</b>{followUp.reason && <span>{followUp.reason}</span>}</div>)}</div></section>}
    </div>
  );
}

function sessionStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    proposed: '제안됨',
    approved: '승인됨',
    scheduled: '예약됨',
    running: '실행 중',
    blocked: '차단됨',
    completed: '완료',
    failed: '실패',
    cancelled: '취소됨',
  };
  return labels[status] || status;
}

function contractDateTime(value: string, timeZone = 'Asia/Seoul'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '미정';
  const formatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month}월 ${parts.day}일 ${parts.hour}:${parts.minute}`;
}

export function TaskSessionPanel(props: TaskSessionPanelProps) {
  const [message, setMessage] = useState('');
  const siblings = props.sessions.filter((session) => session.missionId === props.detail.missionId);
  const appearance = props.task ? agentTaskAppearance(props.task.status) : null;
  const artifacts = props.detail.events.filter((event) => event.kind === 'artifact');

  useEffect(() => setMessage(''), [props.detail.id]);

  const sendMessage = async () => {
    const value = message.trim();
    if (!value || props.sending) return;
    if (await props.onSendMessage(value)) setMessage('');
  };

  return (
    <div className="task-session-backdrop">
      <section className="task-session-panel" role="dialog" aria-modal="true" aria-label={`Task Session: ${props.detail.title}`}>
        <aside className="task-session-list">
          <header><strong>Task Sessions</strong><span>{siblings.length}</span></header>
          {siblings.map((session) => (
            <button data-active={session.id === props.detail.id} key={session.id} onClick={() => props.onOpenSession(session.id)}>
              <strong>{session.title}</strong><span>{sessionStatusLabel(session.status)}</span>
            </button>
          ))}
        </aside>

        <div className="task-session-conversation">
          <header className="task-session-head">
            <div><span>Task Session</span><h2>{props.detail.title}</h2></div>
            <button aria-label="Task Session 닫기" title="닫기" onClick={props.onClose}>×</button>
          </header>
          <div className="task-session-events" aria-live="polite">
            {props.detail.events.map((event) => {
              const link = eventLink(event);
              const result = parseAgentResult(event);
              return (
                <article className="task-session-event" data-kind={event.kind} key={event.id}>
                  <header><strong>{EVENT_LABELS[event.kind]}</strong><time>{sessionTime(event.createdAt)}</time></header>
                  {result ? <AgentResultView result={result} /> : <p className="task-session-event-text">{event.text}</p>}
                  {link && <a href={link} target="_blank" rel="noreferrer">근거 열기</a>}
                </article>
              );
            })}
            {!props.detail.events.length && <div className="agent-operation-empty">세션 이벤트를 기다리는 중입니다.</div>}
          </div>
          <footer className="task-session-composer">
            <textarea aria-label="Task Session 메시지" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="방향을 조정하거나 확인할 내용을 입력하세요" />
            <button disabled={!message.trim() || props.sending} onClick={() => void sendMessage()}>{props.sending ? '전송 중' : '메시지 보내기'}</button>
          </footer>
        </div>

        <aside className="task-session-contract">
          <header><span>현재 계약</span>{appearance && <strong data-tone={appearance.tone}>{appearance.label}</strong>}</header>
          <section><span>미션</span><strong>{props.mission?.title || '연결된 미션 없음'}</strong><p>{props.mission?.objective}</p></section>
          <section><span>이 작업을 만든 이유</span><p>{props.task?.reason || '이유가 기록되지 않았습니다.'}</p></section>
          <section><span>기대 결과</span><strong>{props.task?.expectedOutput || '정의되지 않음'}</strong></section>
          <section className="task-session-contract-grid">
            <div><span>실행 엔진</span><strong>{executionEngineLabel(props.task?.executionEngine || props.detail.executionEngine)}</strong></div>
            <div><span>요청 산출물</span><strong>{deliverableLabel(props.task?.deliverable || props.detail.deliverable)}</strong></div>
          </section>
          <section className="task-session-schedule"><span>캘린더</span><div><b>시작</b><strong>{contractDateTime(props.task?.scheduledAt || '', props.mission?.timezone)}</strong></div><div><b>마감</b><strong>{contractDateTime(props.task?.dueAt || '', props.mission?.timezone)}</strong></div></section>
          <section className="task-session-contract-grid">
            <div><span>예상 시간</span><strong>{props.task?.estimatedMinutes || 0}분</strong></div>
            <div><span>주간 예산</span><strong>{props.mission ? `${props.mission.budget.usedMinutes} / ${props.mission.policy.maxRuntimeMinutesPerWeek}분` : '미정'}</strong></div>
          </section>
          <section><span>허용된 컨텍스트</span><div className="mission-tags">{props.task?.sourceRefs.map((source) => <b key={source}>{source}</b>)}</div></section>
          <section><span>산출물</span><div className="task-session-artifacts">{artifacts.map((artifact) => {
            const link = eventLink(artifact);
            return link
              ? <a href={link} target="_blank" rel="noreferrer" key={artifact.id}>{artifact.text}</a>
              : <b key={artifact.id}>{artifact.text}</b>;
          })}{!artifacts.length && <b>아직 없음</b>}</div></section>
          {props.task?.pauseMode === 'next_checkpoint' && <p className="task-session-checkpoint">일시정지 요청됨 · next checkpoint에서 적용</p>}
          <footer>
            {taskActions(props.task).map((action) => (
              <button className={action === 'cancel' ? 'danger' : ''} disabled={props.busy === props.task?.id} key={action} onClick={() => props.task && void props.onTaskAction(props.task.id, action)}>
                {actionLabel(action)}
              </button>
            ))}
          </footer>
        </aside>
      </section>
    </div>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Agent Task state: ${JSON.stringify(value)}`);
}
