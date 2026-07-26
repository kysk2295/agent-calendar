import { useCallback, useEffect, useRef, useState } from 'react';

import { hermesApi, HermesApiError } from '../../api/hermesApi';
import { consumeAgentWorkLiveSse } from './agentWorkLiveStream';
import type { AgentExecutionEngine } from './types';
import type {
  AgentWorkComparisonTarget,
  AgentWorkDelivery,
  AgentWorkLiveTurnRequest,
} from './workConversationTypes';

export type AgentWorkLiveTurnState = Readonly<{
  active: boolean;
  text: string;
  error: string;
  refreshFailed: boolean;
}>;

const IDLE: AgentWorkLiveTurnState = { active: false, text: '', error: '', refreshFailed: false };
type OwnedAgentWorkLiveTurnState = Readonly<{
  missionId: string;
  turn: AgentWorkLiveTurnState;
}>;

function errorCopy(error: unknown): string {
  if (error instanceof HermesApiError && error.code === 'work_turn_in_progress') {
    return '이 작업에서 이미 응답을 만들고 있습니다. 응답이 끝난 뒤 다시 보내 주세요.';
  }
  return '실시간 응답을 연결하지 못했습니다. 메시지가 저장됐는지 확인한 뒤 다시 시도해 주세요.';
}

export function useAgentWorkLiveTurn(missionId: string, onRefresh: () => Promise<boolean>) {
  const [ownedState, setOwnedState] = useState<OwnedAgentWorkLiveTurnState>({ missionId, turn: IDLE });
  const abortRef = useRef<AbortController | null>(null);
  const retryMessageRef = useRef<Readonly<{
    missionId: string;
    text: string;
    executionEngine?: AgentExecutionEngine;
    requestedModel: string;
    comparisonTargets: readonly AgentWorkComparisonTarget[];
    clientMessageId: string;
  }> | null>(null);
  const missionIdRef = useRef(missionId);
  const onRefreshRef = useRef(onRefresh);
  missionIdRef.current = missionId;
  onRefreshRef.current = onRefresh;
  const state = ownedState.missionId === missionId ? ownedState.turn : IDLE;

  useEffect(() => {
    setOwnedState({ missionId, turn: IDLE });
    retryMessageRef.current = null;
    return () => abortRef.current?.abort();
  }, [missionId]);

  const start = useCallback(async (request: AgentWorkLiveTurnRequest): Promise<AgentWorkDelivery> => {
    if (!missionId) throw new Error('Live Work Conversation requires a selected work');
    if (abortRef.current) throw new Error('Live Work Conversation is already active');
    const controller = new AbortController();
    abortRef.current = controller;
    const turnMissionId = missionId;
    const ownsTurn = () => (
      missionIdRef.current === turnMissionId
      && abortRef.current === controller
      && !controller.signal.aborted
    );
    const updateState = (update: (current: AgentWorkLiveTurnState) => AgentWorkLiveTurnState) => {
      setOwnedState((current) => {
        if (!ownsTurn()) return current;
        return {
          missionId: turnMissionId,
          turn: update(current.missionId === turnMissionId ? current.turn : IDLE),
        };
      });
    };
    setOwnedState({ missionId: turnMissionId, turn: { active: true, text: '', error: '', refreshFailed: false } });
    const refresh = async () => {
      if (missionIdRef.current !== turnMissionId) return false;
      try {
        return await onRefreshRef.current();
      } catch {
        return false;
      }
    };
    return new Promise<AgentWorkDelivery>((resolve, reject) => {
      let accepted = false;
      let completed = false;
      let streamError = '';
      let durableTerminalError = false;
      void (async () => {
        try {
          const response = await hermesApi.streamAgentWorkTurn(missionId, request, controller.signal);
          await consumeAgentWorkLiveSse(response, async (event) => {
            if (!ownsTurn()) return;
            if (event.type === 'accepted') {
              accepted = true;
              resolve(event.delivery);
              void refresh().then((refreshed) => {
                if (!refreshed) updateState((current) => ({ ...current, refreshFailed: true }));
              });
              return;
            }
            if (event.type === 'delta') {
              updateState((current) => ({ ...current, active: true, text: `${current.text}${event.text}` }));
              return;
            }
            if (event.type === 'checkpoint') {
              durableTerminalError = event.checkpoint.kind === 'error';
              return;
            }
            if (event.type === 'error') {
              streamError = event.message;
              updateState((current) => ({ ...current, active: false, error: event.message }));
              return;
            }
            if (event.type === 'done') {
              const refreshed = await refresh();
              if (!streamError || refreshed || durableTerminalError) {
                updateState(() => refreshed ? IDLE : { ...IDLE, refreshFailed: true });
              }
              completed = true;
            }
          });
          if (!accepted) throw new Error('Live Work Conversation did not acknowledge the message');
          if (!completed && !streamError) {
            updateState((current) => ({
              ...current,
              active: false,
              error: '실시간 응답이 중단되었습니다. 부분 응답을 확인한 뒤 다시 시도해 주세요.',
            }));
          }
        } catch (error: unknown) {
          const message = errorCopy(error);
          updateState((current) => ({
            active: false,
            text: accepted ? current.text : '',
            error: current.error || message,
            refreshFailed: false,
          }));
          if (!accepted) reject(error instanceof Error ? error : new Error(message));
        } finally {
          if (accepted && !completed) await refresh();
          if (abortRef.current === controller) abortRef.current = null;
        }
      })();
    });
  }, [missionId]);

  const send = useCallback(async (
    text: string,
    executionEngine?: AgentExecutionEngine,
    requestedModel = '',
    comparisonTargets: readonly AgentWorkComparisonTarget[] = [],
  ) => {
    const model = requestedModel.trim();
    const targets = comparisonTargets.map((target) => ({
      executionEngine: target.executionEngine,
      ...(target.requestedModel?.trim() ? { requestedModel: target.requestedModel.trim() } : {}),
    }));
    const pending = retryMessageRef.current?.missionId === missionId
      && retryMessageRef.current.text === text
      && retryMessageRef.current.executionEngine === executionEngine
      && retryMessageRef.current.requestedModel === model
      && JSON.stringify(retryMessageRef.current.comparisonTargets) === JSON.stringify(targets)
      ? retryMessageRef.current
      : {
        missionId,
        text,
        executionEngine,
        requestedModel: model,
        comparisonTargets: targets,
        clientMessageId: globalThis.crypto.randomUUID(),
      };
    retryMessageRef.current = pending;
    try {
      const accepted = await start({
        text: pending.text,
        ...(pending.executionEngine ? { executionEngine: pending.executionEngine } : {}),
        ...(pending.requestedModel ? { requestedModel: pending.requestedModel } : {}),
        ...(pending.comparisonTargets.length ? { comparisonTargets: pending.comparisonTargets } : {}),
        clientMessageId: pending.clientMessageId,
      });
      if (retryMessageRef.current === pending) retryMessageRef.current = null;
      return accepted;
    } catch (error) {
      throw error;
    }
  }, [missionId, start]);
  const startInitial = useCallback(() => start({ initial: true }), [start]);

  return { state, send, startInitial };
}
