import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { hermesApi } from '../../api/hermesApi';
import { agentWorkAggregateFingerprint, agentWorkPollDelay, loadCompleteAgentWorkConversation } from './workConversationClient';
import type { AgentWorkConversationPage } from './workConversationTypes';

function waitForAggregateCommit(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

type AgentWorkConversationState = Readonly<{
  conversation: AgentWorkConversationPage | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<boolean>;
  refreshAfterMutation: () => Promise<boolean>;
}>;

export function useAgentWorkConversation(selectedMissionId: string, onRefreshAggregate: () => Promise<boolean>): AgentWorkConversationState {
  const [conversation, setConversation] = useState<AgentWorkConversationPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const selectedMissionIdRef = useRef('');
  const conversationRef = useRef<AgentWorkConversationPage | null>(null);
  const requestRef = useRef<Promise<AgentWorkConversationPage | null> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refreshAggregateRef = useRef(onRefreshAggregate);
  selectedMissionIdRef.current = selectedMissionId;
  refreshAggregateRef.current = onRefreshAggregate;

  const fetchConversation = useCallback(async (missionId: string, surfaceError: boolean, syncAggregateOnChange: boolean): Promise<AgentWorkConversationPage | null> => {
    if (requestRef.current) return null;
    const controller = new AbortController();
    abortRef.current = controller;
    const request = (async (): Promise<AgentWorkConversationPage | null> => {
      try {
        const next = await loadCompleteAgentWorkConversation(missionId, (workId, options) => hermesApi.getAgentWorkConversation(workId, options), controller.signal);
        if (selectedMissionIdRef.current !== missionId) return null;
        const previous = conversationRef.current;
        if (syncAggregateOnChange && previous && agentWorkAggregateFingerprint(previous) !== agentWorkAggregateFingerprint(next)) {
          const aggregateFresh = await refreshAggregateRef.current();
          if (!aggregateFresh || selectedMissionIdRef.current !== missionId) return null;
          await waitForAggregateCommit();
        }
        conversationRef.current = next;
        setConversation(next);
        setError('');
        return next;
      } catch (caught: unknown) {
        if (!(caught instanceof Error)) throw caught;
        if (controller.signal.aborted || selectedMissionIdRef.current !== missionId) return null;
        if (surfaceError) setError(caught.message || '작업 대화를 불러오지 못했습니다.');
        return null;
      }
    })();
    requestRef.current = request;
    try {
      return await request;
    } finally {
      if (requestRef.current === request) requestRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    abortRef.current?.abort();
    if (!selectedMissionId) {
      conversationRef.current = null;
      setConversation(null);
      setError('');
      setLoading(false);
      return;
    }
    conversationRef.current = null;
    setConversation(null);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (page: AgentWorkConversationPage | null) => {
      if (disposed) return;
      const terminal = page ? ['completed', 'failed', 'cancelled'].includes(page.work.status) && !page.work.revision.pendingRevisionId : false;
      timer = setTimeout(() => { void poll(); }, agentWorkPollDelay({ visible: document.visibilityState === 'visible', terminal }));
    };
    const poll = async () => {
      if (disposed) return;
      if (document.visibilityState !== 'visible') {
        schedule(conversationRef.current);
        return;
      }
      const next = await fetchConversation(selectedMissionId, conversationRef.current === null, true);
      schedule(next || conversationRef.current);
    };
    const visibilityChange = () => {
      if (document.visibilityState !== 'visible' || disposed) return;
      if (timer) clearTimeout(timer);
      timer = null;
      void poll();
    };
    setLoading(true);
    setError('');
    document.addEventListener('visibilitychange', visibilityChange);
    void poll().finally(() => {
      if (!disposed && selectedMissionIdRef.current === selectedMissionId) setLoading(false);
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChange);
      abortRef.current?.abort();
    };
  }, [fetchConversation, selectedMissionId]);

  const refresh = async (): Promise<boolean> => {
    if (!selectedMissionId) return false;
    const activeRequest = requestRef.current;
    if (activeRequest) {
      try {
        await activeRequest;
      } catch (caught: unknown) {
        if (!(caught instanceof Error)) throw caught;
      }
    }
    if (selectedMissionIdRef.current !== selectedMissionId) return false;
    return Boolean(await fetchConversation(selectedMissionId, true, false));
  };

  const refreshAfterMutation = async (): Promise<boolean> => {
    if (!selectedMissionId) return false;
    const activeRequest = requestRef.current;
    if (activeRequest) await activeRequest;
    if (selectedMissionIdRef.current !== selectedMissionId) return false;
    if (!await refreshAggregateRef.current()) return false;
    await waitForAggregateCommit();
    return Boolean(await fetchConversation(selectedMissionId, true, false));
  };

  return { conversation, loading, error, refresh, refreshAfterMutation };
}
