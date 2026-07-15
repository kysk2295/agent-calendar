import { useCallback, useEffect, useRef, useState } from 'react';

import { hermesApi, HermesApiError } from '../../api/hermesApi';
import { consumeAgentWorkLiveSse } from './agentWorkLiveStream';
import type { AgentWorkDelivery, AgentWorkLiveTurnRequest } from './workConversationTypes';

export type AgentWorkLiveTurnState = Readonly<{
  active: boolean;
  text: string;
  error: string;
}>;

const IDLE: AgentWorkLiveTurnState = { active: false, text: '', error: '' };

function errorCopy(error: unknown): string {
  if (error instanceof HermesApiError && error.code === 'work_turn_in_progress') {
    return '이 작업에서 이미 응답을 만들고 있습니다. 응답이 끝난 뒤 다시 보내 주세요.';
  }
  return '실시간 응답을 연결하지 못했습니다. 메시지가 저장됐는지 확인한 뒤 다시 시도해 주세요.';
}

export function useAgentWorkLiveTurn(missionId: string, onRefresh: () => Promise<boolean>) {
  const [state, setState] = useState<AgentWorkLiveTurnState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const retryMessageRef = useRef<Readonly<{ text: string; clientMessageId: string }> | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => () => abortRef.current?.abort(), [missionId]);

  const start = useCallback(async (request: AgentWorkLiveTurnRequest): Promise<AgentWorkDelivery> => {
    if (!missionId) throw new Error('Live Work Conversation requires a selected work');
    if (abortRef.current) throw new Error('Live Work Conversation is already active');
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ active: true, text: '', error: '' });
    return new Promise<AgentWorkDelivery>((resolve, reject) => {
      let accepted = false;
      let completed = false;
      let streamError = '';
      let durableTerminalError = false;
      void (async () => {
        try {
          const response = await hermesApi.streamAgentWorkTurn(missionId, request, controller.signal);
          await consumeAgentWorkLiveSse(response, async (event) => {
            if (event.type === 'accepted') {
              accepted = true;
              resolve(event.delivery);
              void onRefreshRef.current();
              return;
            }
            if (event.type === 'delta') {
              setState((current) => ({ ...current, active: true, text: `${current.text}${event.text}` }));
              return;
            }
            if (event.type === 'checkpoint') {
              durableTerminalError = event.checkpoint.kind === 'error';
              return;
            }
            if (event.type === 'error') {
              streamError = event.message;
              setState((current) => ({ ...current, active: false, error: event.message }));
              return;
            }
            if (event.type === 'done') {
              const refreshed = await onRefreshRef.current();
              if (!streamError || refreshed || durableTerminalError) setState(IDLE);
              completed = true;
            }
          });
          if (!accepted) throw new Error('Live Work Conversation did not acknowledge the message');
        } catch (error: unknown) {
          const message = errorCopy(error);
          setState({ active: false, text: '', error: message });
          if (!accepted) reject(error instanceof Error ? error : new Error(message));
        } finally {
          if (accepted && !completed) await onRefreshRef.current();
          if (abortRef.current === controller) abortRef.current = null;
        }
      })();
    });
  }, [missionId]);

  const send = useCallback(async (text: string) => {
    const pending = retryMessageRef.current?.text === text
      ? retryMessageRef.current
      : { text, clientMessageId: globalThis.crypto.randomUUID() };
    retryMessageRef.current = pending;
    try {
      const accepted = await start(pending);
      retryMessageRef.current = null;
      return accepted;
    } catch (error) {
      throw error;
    }
  }, [start]);
  const startInitial = useCallback(() => start({ initial: true }), [start]);

  return { state, send, startInitial };
}
