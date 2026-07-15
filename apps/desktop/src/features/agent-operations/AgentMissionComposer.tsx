import { useEffect, useRef, useState } from 'react';

import {
  DELIVERABLE_FORMATS,
  DELIVERABLE_OPTIONS,
  EXECUTION_ENGINE_OPTIONS,
} from './executionContracts';
import type {
  AgentCreatedWork,
  AgentDeliverableKind,
  AgentExecutionEngine,
  AgentMissionCreateInput,
  AgentRosterEntry,
} from './types';

type AgentMissionComposerProps = {
  readonly agents: readonly AgentRosterEntry[];
  readonly busy: boolean;
  readonly initialTitle?: string;
  readonly initialObjective?: string;
  readonly onClose: () => void;
  readonly onCreate: (input: AgentMissionCreateInput) => Promise<AgentCreatedWork | null>;
};

export function AgentMissionComposer(props: AgentMissionComposerProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [title, setTitle] = useState(props.initialTitle || '새 에이전트 작업');
  const [objective, setObjective] = useState(props.initialObjective || '');
  const [agentId, setAgentId] = useState(props.agents[0]?.id || 'default');
  const [executionEngine, setExecutionEngine] = useState<AgentExecutionEngine>('hermes');
  const [deliverableKind, setDeliverableKind] = useState<AgentDeliverableKind>('report');
  const [format, setFormat] = useState('markdown');

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = formRef.current;
    if (!dialog) return undefined;
    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'));
    focusableElements()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', handleKeyDown);
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [props.onClose]);

  const changeDeliverableKind = (value: string) => {
    const kind: AgentDeliverableKind = value === 'document' || value === 'image' || value === 'file'
      ? value
      : 'report';
    setDeliverableKind(kind);
    setFormat(DELIVERABLE_FORMATS[kind][0]?.value || '');
  };

  const submit = async () => {
    const input: AgentMissionCreateInput = {
      templateId: 'general-agent-work',
      title: title.trim(),
      objective: objective.trim(),
      agentId,
      executionEngine,
      deliverable: { kind: deliverableKind, format },
    };
    if (!input.title || !input.objective || props.busy) return;
    const created = await props.onCreate(input);
    if (created) props.onClose();
  };

  return (
    <div className="agent-mission-composer-backdrop">
      <form ref={formRef} className="agent-mission-composer" role="dialog" aria-modal="true" aria-label="새 에이전트 미션" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <header>
          <div><span>새 미션</span><h2>에이전트에게 작업 맡기기</h2></div>
          <button type="button" aria-label="새 미션 닫기" onClick={props.onClose}>×</button>
        </header>
        <div className="agent-mission-composer-fields">
          <label>
            <span>미션 제목</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 경쟁사 가격 정책 조사" required />
          </label>
          <label>
            <span>작업 목표</span>
            <textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="무엇을 조사하거나 만들고, 어떤 형태로 받으려는지 적으세요." required />
          </label>
          <label>
            <span>담당 에이전트</span>
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {props.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}
              {!props.agents.length && <option value="default">default</option>}
            </select>
          </label>
        </div>
        <fieldset className="agent-engine-selector">
          <legend>실행 엔진</legend>
          <div>
            {EXECUTION_ENGINE_OPTIONS.map((option) => (
              <button type="button" data-active={executionEngine === option.value} aria-label={option.label} aria-pressed={executionEngine === option.value} key={option.value} onClick={() => setExecutionEngine(option.value)}>
                <strong>{option.label}</strong><span>{option.detail}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="agent-deliverable-fields">
          <label>
            <span>산출물 종류</span>
            <select value={deliverableKind} onChange={(event) => changeDeliverableKind(event.target.value)}>
              {DELIVERABLE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>파일 형식</span>
            <select value={format} onChange={(event) => setFormat(event.target.value)}>
              {DELIVERABLE_FORMATS[deliverableKind].map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <footer>
          <button type="button" onClick={props.onClose}>취소</button>
          <button className="primary" type="submit" disabled={!title.trim() || !objective.trim() || props.busy}>{props.busy ? '생성 중' : '미션 생성'}</button>
        </footer>
      </form>
    </div>
  );
}
