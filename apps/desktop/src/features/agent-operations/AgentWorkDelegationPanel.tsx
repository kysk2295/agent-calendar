import { useState } from 'react';

import { hermesApi } from '../../api/hermesApi';
import type {
  AgentWorkConversationPage,
  AgentWorkHandoff,
  AgentWorkProviderSessionTransition,
} from './workConversationTypes';

type AgentWorkDelegationPanelProps = {
  readonly missionId: string;
  readonly conversation: AgentWorkConversationPage;
  readonly disabled: boolean;
  readonly onRefresh: () => Promise<boolean>;
};

type MutationState = {
  readonly pending: boolean;
  readonly receipt: string;
  readonly error: string;
};

const IDLE_MUTATION: MutationState = { pending: false, receipt: '', error: '' };

function mutationId(prefix: string): string {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${suffix}`;
}

function capabilities(value: string): readonly string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : '요청을 완료하지 못했습니다.';
}

function activeProviderSessionId(conversation: AgentWorkConversationPage): string {
  return conversation.activeProviderSessionId
    || conversation.providerSessionTransitions.at(-1)?.targetProviderSessionId
    || conversation.providerSessions.find((session) => session.status === 'active')?.id
    || '';
}

function latestTransition(
  transitions: readonly AgentWorkProviderSessionTransition[],
): AgentWorkProviderSessionTransition | undefined {
  return transitions.at(-1);
}

function HandoffRow(props: Readonly<{
  handoff: AgentWorkHandoff;
  disabled: boolean;
  onCancel: (handoff: AgentWorkHandoff) => Promise<void>;
}>) {
  const { handoff } = props;
  const terminal = ['completed', 'failed', 'cancelled'].includes(handoff.status);
  return (
    <li className="agent-work-handoff-row" data-status={handoff.status}>
      <header>
        <strong>{handoff.delegatorAgentId} → {handoff.receiverAgentId}</strong>
        <span>depth {handoff.depth} · {handoff.status}</span>
      </header>
      <p><b>Lineage</b>{handoff.lineage.join(' → ')}</p>
      <p><b>Allow</b>{handoff.effectiveGrants.allow.join(', ') || 'none'}</p>
      <p><b>Deny</b>{handoff.effectiveGrants.deny.join(', ') || 'none'}</p>
      <p>
        <b>Budget</b>
        {handoff.effectiveBudget.maxRuns} runs · {handoff.effectiveBudget.maxMinutes} min · ${handoff.effectiveBudget.maxCostUsd.toFixed(2)}
      </p>
      {!terminal && (
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => void props.onCancel(handoff)}
        >
          Cancel child {handoff.receiverAgentId}
        </button>
      )}
    </li>
  );
}

export function AgentWorkDelegationPanel(props: AgentWorkDelegationPanelProps) {
  const [receiverAgentId, setReceiverAgentId] = useState('');
  const [goal, setGoal] = useState('');
  const [parentHandoffId, setParentHandoffId] = useState('');
  const [requestedAllow, setRequestedAllow] = useState('');
  const [requestedDeny, setRequestedDeny] = useState('');
  const [maxRuns, setMaxRuns] = useState('2');
  const [maxMinutes, setMaxMinutes] = useState('30');
  const [maxCostUsd, setMaxCostUsd] = useState('5');
  const [providerSessionId, setProviderSessionId] = useState(
    activeProviderSessionId(props.conversation),
  );
  const [transitionText, setTransitionText] = useState('');
  const [mutation, setMutation] = useState<MutationState>(IDLE_MUTATION);
  const activeSessionId = activeProviderSessionId(props.conversation);
  const latest = latestTransition(props.conversation.providerSessionTransitions);
  const controlsDisabled = props.disabled || mutation.pending;

  const mutate = async (pendingReceipt: string, action: () => Promise<unknown>) => {
    setMutation({ pending: true, receipt: pendingReceipt, error: '' });
    try {
      await action();
      const refreshed = await props.onRefresh();
      setMutation({
        pending: false,
        receipt: refreshed ? `${pendingReceipt} 완료` : `${pendingReceipt} 저장됨 · 새로고침 필요`,
        error: '',
      });
    } catch (error: unknown) {
      setMutation({ pending: false, receipt: '', error: readableError(error) });
    }
  };

  const handoff = async () => {
    const receiver = receiverAgentId.trim();
    const boundedGoal = goal.trim();
    if (!receiver || !boundedGoal) {
      setMutation({ pending: false, receipt: '', error: 'Child receiver와 goal을 입력해 주세요.' });
      return;
    }
    const parent = props.conversation.handoffGraph.handoffs.find(
      (item) => item.id === parentHandoffId,
    );
    await mutate('Bounded child handoff', () => hermesApi.createAgentWorkHandoff(
      props.missionId,
      {
        clientRequestId: mutationId('handoff'),
        delegatorAgentId: parent?.receiverAgentId
          || props.conversation.handoffGraph.rootAgentId,
        receiverAgentId: receiver,
        goal: boundedGoal,
        ...(parentHandoffId ? { parentHandoffId } : {}),
        requestedGrants: {
          allow: capabilities(requestedAllow),
          deny: capabilities(requestedDeny),
        },
        requestedBudget: {
          maxRuns: Number(maxRuns),
          maxMinutes: Number(maxMinutes),
          maxCostUsd: Number(maxCostUsd),
        },
      },
    ));
    setReceiverAgentId('');
    setGoal('');
  };

  const cancel = async (item: AgentWorkHandoff) => {
    await mutate('Child cancellation', () => hermesApi.cancelAgentWorkHandoff(
      props.missionId,
      item.id,
      { reason: 'user_cancelled' },
    ));
  };

  const transition = async (action: 'rebind' | 'new_session' | 'fork') => {
    const selected = providerSessionId.trim();
    const text = transitionText.trim();
    if (!text || (action !== 'new_session' && !selected)) {
      setMutation({
        pending: false,
        receipt: '',
        error: 'Provider session과 transition instruction을 확인해 주세요.',
      });
      return;
    }
    await mutate(`Provider ${action}`, () => hermesApi.transitionAgentWorkProviderSession(
      props.missionId,
      {
        clientRequestId: mutationId('transition'),
        action,
        expectedActiveProviderSessionId: activeSessionId,
        text,
        ...(action === 'rebind' ? { targetProviderSessionId: selected } : {}),
        ...(action === 'fork' ? { sourceProviderSessionId: selected } : {}),
      },
    ));
    setTransitionText('');
  };

  const adopt = async (reportId: string) => {
    await mutate('Comparison result adoption', () => hermesApi.adoptAgentWorkComparisonResult(
      props.missionId,
      {
        selectionId: mutationId('selection'),
        reportId,
        expectedCurrentResultReportId: props.conversation.comparison.currentResultReportId,
      },
    ));
  };

  return (
    <details className="agent-work-delegation" data-testid="agent-work-delegation">
      <summary>
        <span>
          <strong>Delegated Work</strong>
          <small>Bounded child handoffs, explicit provider sessions, and comparison adoption</small>
        </span>
        <b>{props.conversation.handoffGraph.handoffs.length} children</b>
      </summary>
      <div className="agent-work-delegation-body">
        <section aria-labelledby="handoff-heading">
          <header>
            <div>
              <h2 id="handoff-heading">Child handoff</h2>
              <p>Root agent stays {props.conversation.handoffGraph.rootAgentId}. Depth ≤ {props.conversation.handoffGraph.maxDepth}; fan-out ≤ {props.conversation.handoffGraph.maxFanOut}.</p>
            </div>
          </header>
          <div className="agent-work-delegation-form">
            <label>Receiver<input aria-label="Child receiver Agent ID" value={receiverAgentId} onChange={(event) => setReceiverAgentId(event.target.value)} /></label>
            <label>Parent<select aria-label="Parent handoff" value={parentHandoffId} onChange={(event) => setParentHandoffId(event.target.value)}><option value="">Root work</option>{props.conversation.handoffGraph.handoffs.map((item) => <option key={item.id} value={item.id}>{item.receiverAgentId} · depth {item.depth}</option>)}</select></label>
            <label className="agent-work-delegation-wide">Goal<textarea aria-label="Child handoff goal" value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
            <label>Allow<input aria-label="Child requested grants" value={requestedAllow} onChange={(event) => setRequestedAllow(event.target.value)} placeholder="tool:workspace.read" /></label>
            <label>Deny<input aria-label="Child denied grants" value={requestedDeny} onChange={(event) => setRequestedDeny(event.target.value)} /></label>
            <label>Runs<input aria-label="Child max runs" type="number" min="1" value={maxRuns} onChange={(event) => setMaxRuns(event.target.value)} /></label>
            <label>Minutes<input aria-label="Child max minutes" type="number" min="1" value={maxMinutes} onChange={(event) => setMaxMinutes(event.target.value)} /></label>
            <label>Cost USD<input aria-label="Child max cost" type="number" min="0.01" step="0.01" value={maxCostUsd} onChange={(event) => setMaxCostUsd(event.target.value)} /></label>
            <button type="button" disabled={controlsDisabled} onClick={() => void handoff()}>Hand off bounded child</button>
          </div>
          <ol className="agent-work-handoff-list">
            {props.conversation.handoffGraph.handoffs.map((item) => (
              <HandoffRow key={item.id} handoff={item} disabled={controlsDisabled} onCancel={cancel} />
            ))}
          </ol>
        </section>

        <section aria-labelledby="provider-session-heading">
          <header>
            <div>
              <h2 id="provider-session-heading">Provider session</h2>
              <p>Active pointer: {activeSessionId || 'none'}{latest ? ` · last ${latest.action}` : ''}</p>
            </div>
          </header>
          <div className="agent-work-delegation-form">
            <label>Session<input aria-label="Provider session ID" list="agent-work-provider-sessions" value={providerSessionId} onChange={(event) => setProviderSessionId(event.target.value)} /></label>
            <datalist id="agent-work-provider-sessions">{props.conversation.providerSessions.map((session) => <option key={session.id} value={session.id}>{session.engine} · generation {session.generation}</option>)}</datalist>
            <label className="agent-work-delegation-wide">Instruction<textarea aria-label="Provider transition instruction" value={transitionText} onChange={(event) => setTransitionText(event.target.value)} /></label>
            <button type="button" disabled={controlsDisabled} onClick={() => void transition('rebind')}>Rebind selected session</button>
            <button type="button" disabled={controlsDisabled || !activeSessionId} onClick={() => void transition('new_session')}>Start new provider session</button>
            <button type="button" disabled={controlsDisabled} onClick={() => void transition('fork')}>Fork selected session</button>
          </div>
          <ol className="agent-work-provider-list">
            {props.conversation.providerSessions.map((session) => (
              <li key={session.id} data-active={session.id === activeSessionId}>
                <strong>{session.title || session.id}</strong>
                <span>{session.engine} · generation {session.generation} · {session.transitionAction}</span>
                <small>{session.lineage.join(' → ')}</small>
              </li>
            ))}
          </ol>
          {props.conversation.providerSessionTransitions.length > 0 && (
            <ol className="agent-work-transition-list" aria-label="Provider session transition history">
              {props.conversation.providerSessionTransitions.map((item) => (
                <li key={item.id}>
                  <strong>{item.action}</strong>
                  <span>{item.sourceProviderSessionId || 'new'} → {item.targetProviderSessionId}</span>
                  <small>job {item.executionJobId}</small>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby="comparison-heading">
          <header>
            <div>
              <h2 id="comparison-heading">Comparison results</h2>
              <p>Adoption changes only the current result pointer.</p>
            </div>
          </header>
          <div className="agent-work-comparison-grid">
            {props.conversation.comparison.outcomes.map((outcome) => {
              const selected = outcome.reportId === props.conversation.comparison.currentResultReportId;
              return (
                <article key={outcome.reportId} data-current={selected}>
                  <header><strong>{outcome.executionEngine}</strong><span>{selected ? 'Current result' : `Result ${outcome.turnTargetIndex + 1}`}</span></header>
                  <p>{outcome.summary || outcome.reportId}</p>
                  <dl>
                    <div><dt>Duration</dt><dd>{Math.round(outcome.durationMs / 1000)}s</dd></div>
                    <div><dt>Cost</dt><dd>${outcome.costUsd.toFixed(2)}</dd></div>
                    <div><dt>Evidence</dt><dd>{outcome.evidenceCount}</dd></div>
                  </dl>
                  <button type="button" disabled={controlsDisabled || selected} onClick={() => void adopt(outcome.reportId)}>Adopt result {outcome.executionEngine}</button>
                </article>
              );
            })}
          </div>
        </section>
        {mutation.receipt && <p className="agent-work-delegation-receipt" role="status" aria-live="polite">{mutation.receipt}</p>}
        {mutation.error && <p className="agent-work-delegation-error" role="alert">{mutation.error}</p>}
      </div>
    </details>
  );
}
