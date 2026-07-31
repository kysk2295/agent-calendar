import { ArrowUp, CaretDown } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { deliveryCopy } from './workConversationPresentation';
import type { RunnerEngineModels } from '../runner/runnerApi';
import type { AgentExecutionEngine } from './types';
import type {
  AgentWorkComparisonTarget,
  AgentWorkDelivery,
} from './workConversationTypes';

type AgentWorkComposerProps = {
  readonly onSend: (
    text: string,
    executionEngine: AgentExecutionEngine | undefined,
    requestedModel: string,
    comparisonTargets?: readonly AgentWorkComparisonTarget[],
  ) => Promise<AgentWorkDelivery>;
  readonly streaming: boolean;
  readonly refreshError: string;
  readonly activeEngine: AgentExecutionEngine;
  readonly activeModel: string;
  readonly modelCapabilities: Readonly<Record<string, RunnerEngineModels>>;
  readonly availableEngines: readonly AgentWorkComparisonTarget['executionEngine'][];
};

const RESPONSE_ENGINES: readonly Readonly<{ value: AgentExecutionEngine; label: string }>[] = [
  { value: 'auto', label: '현재 엔진' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'grok', label: 'Grok' },
  { value: 'hermes', label: 'Hermes' },
];

const COMPARISON_ENGINE_LABELS: Readonly<Record<AgentWorkComparisonTarget['executionEngine'], string>> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  hermes: 'Hermes',
};

export function comparisonTargetsForEngines(
  engines: readonly AgentExecutionEngine[],
): readonly AgentWorkComparisonTarget[] {
  const supported = new Set<AgentWorkComparisonTarget['executionEngine']>([
    'codex',
    'claude',
    'grok',
    'hermes',
  ]);
  const unique = new Set<AgentWorkComparisonTarget['executionEngine']>();
  for (const engine of engines) {
    if (supported.has(engine as AgentWorkComparisonTarget['executionEngine'])) {
      unique.add(engine as AgentWorkComparisonTarget['executionEngine']);
    }
  }
  return [...unique].slice(0, 4).map((executionEngine) => ({ executionEngine }));
}

export function AgentWorkComposer(props: AgentWorkComposerProps) {
  const [draft, setDraft] = useState('');
  const [executionEngine, setExecutionEngine] = useState<AgentExecutionEngine>(props.activeEngine);
  const [requestedModel, setRequestedModel] = useState(props.activeModel || '');
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonEngines, setComparisonEngines] = useState<readonly AgentWorkComparisonTarget['executionEngine'][]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [delivery, setDelivery] = useState<AgentWorkDelivery | null>(null);
  const availableEngineKey = props.availableEngines.join('|');
  useEffect(() => {
    setExecutionEngine(props.activeEngine);
    setRequestedModel(props.activeModel || '');
  }, [props.activeEngine, props.activeModel]);
  useEffect(() => {
    setComparisonEngines((current) => current.filter((engine) => props.availableEngines.includes(engine)));
    if (props.availableEngines.length < 2) setComparisonMode(false);
  }, [availableEngineKey]);
  const submit = async () => {
    const text = draft.trim();
    const comparisonTargets = comparisonMode
      ? comparisonTargetsForEngines(comparisonEngines)
      : [];
    if (!text || sending || props.streaming || (comparisonMode && comparisonTargets.length < 2)) return;
    setSending(true);
    setError('');
    setDelivery(null);
    try {
      setDelivery(await props.onSend(
        text,
        comparisonMode ? undefined : executionEngine,
        comparisonMode ? '' : requestedModel,
        comparisonTargets,
      ));
    } catch (caught: unknown) {
      if (!(caught instanceof Error)) throw caught;
      setError('메시지를 보내지 못했습니다. 입력을 유지했습니다. 다시 시도해 주세요.');
      setSending(false);
      return;
    }
    setDraft('');
    setSending(false);
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };
  const visibleError = error || props.refreshError;
  const comparisonReady = props.availableEngines.length >= 2;
  const comparisonTargetCount = comparisonTargetsForEngines(comparisonEngines).length;
  const toggleComparison = () => {
    if (!comparisonReady || sending || props.streaming) return;
    setComparisonMode((current) => {
      if (!current) {
        const active = props.availableEngines.includes(
          executionEngine as AgentWorkComparisonTarget['executionEngine'],
        )
          ? executionEngine as AgentWorkComparisonTarget['executionEngine']
          : props.availableEngines[0];
        const next = [
          active,
          ...props.availableEngines.filter((engine) => engine !== active),
        ].filter(Boolean).slice(0, 2) as AgentWorkComparisonTarget['executionEngine'][];
        setComparisonEngines(next);
      }
      return !current;
    });
  };
  const toggleComparisonEngine = (engine: AgentWorkComparisonTarget['executionEngine']) => {
    setComparisonEngines((current) => (
      current.includes(engine)
        ? current.filter((candidate) => candidate !== engine)
        : [...current, engine].slice(0, 4)
    ));
  };
  const modelCapability = props.modelCapabilities?.[executionEngine] || {
    models: [],
    defaultModel: '',
    modelSelection: 'identifier',
  };
  return (
    <section className="agent-work-composer" aria-label="작업 대화 입력">
      {delivery && <p className="agent-work-delivery" role="status">{deliveryCopy(delivery.status, delivery.applicationMode)}</p>}
      {visibleError && <p className="agent-work-message-error" role="alert">{visibleError}</p>}
      <textarea aria-label="작업 대화 메시지" rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder="메시지를 입력하세요" />
      <details className="agent-work-composer-advanced">
        <summary>고급 실행 설정</summary>
        <div className="agent-work-composer-advanced-body">
          {comparisonMode && <fieldset className="agent-work-comparison-targets">
            <legend>비교할 실행 엔진</legend>
            {props.availableEngines.map((engine) => <label key={engine}>
              <input
                type="checkbox"
                checked={comparisonEngines.includes(engine)}
                disabled={sending || props.streaming}
                onChange={() => toggleComparisonEngine(engine)}
              />
              <span>{COMPARISON_ENGINE_LABELS[engine]}</span>
            </label>)}
            <small>{comparisonTargetCount < 2 ? '두 개 이상 선택하세요.' : `${comparisonTargetCount}개 엔진이 같은 메시지에 각각 응답합니다.`}</small>
          </fieldset>}
          <div className="agent-work-composer-advanced-controls">
            {!comparisonMode && <label className="agent-work-composer-engine">
              <select
                aria-label="이 메시지의 실행 엔진"
                value={executionEngine}
                disabled={sending || props.streaming}
                onChange={(event) => {
                  setExecutionEngine(event.target.value as AgentExecutionEngine);
                  setRequestedModel('');
                }}
              >
                {RESPONSE_ENGINES.map((engine) => <option key={engine.value} value={engine.value}>{engine.label}</option>)}
              </select>
              <CaretDown aria-hidden="true" size={12} weight="bold" />
            </label>}
            {!comparisonMode && <label className="agent-work-composer-model">
              {modelCapability.models.length ? (
                <select
                  aria-label="이 메시지의 실행 모델"
                  value={requestedModel}
                  disabled={sending || props.streaming}
                  onChange={(event) => setRequestedModel(event.target.value)}
                >
                  <option value="">Runner 기본 모델</option>
                  {modelCapability.models.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              ) : (
                <input
                  aria-label="이 메시지의 실행 모델"
                  value={requestedModel}
                  disabled={sending || props.streaming}
                  onChange={(event) => setRequestedModel(event.target.value)}
                  placeholder={modelCapability.defaultModel
                    ? `Runner 기본 · ${modelCapability.defaultModel}`
                    : 'Runner 기본 모델'}
                  inputMode="text"
                />
              )}
            </label>}
            <button
              className="agent-work-composer-compare"
              type="button"
              aria-label="여러 실행 엔진 비교"
              aria-pressed={comparisonMode}
              disabled={!comparisonReady || sending || props.streaming}
              title={comparisonReady ? '같은 메시지를 선택한 엔진별로 비교 실행합니다.' : '인증된 실행 엔진이 두 개 이상 필요합니다.'}
              onClick={toggleComparison}
            >
              {comparisonMode ? '비교 취소' : '엔진 비교'}
            </button>
          </div>
        </div>
      </details>
      <div className="agent-work-composer-toolbar">
        <button className="agent-work-composer-send" type="button" aria-label="작업 대화에 보내기" disabled={!draft.trim() || sending || props.streaming || (comparisonMode && comparisonTargetCount < 2)} onClick={() => void submit()}>
          <ArrowUp aria-hidden="true" size={17} weight="bold" />
          <span>{sending ? '전송 중' : props.streaming ? '응답 중' : '보내기'}</span>
        </button>
      </div>
      <small className="agent-work-composer-hint" aria-label={comparisonMode
        ? '같은 작업 대화에서 선택한 엔진을 명시적으로 비교합니다. Enter로 전송, Shift+Enter로 줄바꿈'
        : '같은 위임 작업에 이어서 보냅니다. Enter로 전송, Shift+Enter로 줄바꿈'}>
        <span>{comparisonMode ? '같은 위임 작업 · 명시적 엔진 비교' : '같은 위임 작업에 이어서 보내기'}</span>
        <span>Enter로 전송 · Shift+Enter로 줄바꿈</span>
      </small>
    </section>
  );
}
