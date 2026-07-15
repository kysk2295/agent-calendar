import { useState } from 'react';

import type { AgentWorkDelivery } from './workConversationTypes';

type AgentWorkComposerProps = {
  readonly onSend: (text: string) => Promise<AgentWorkDelivery>;
  readonly streaming: boolean;
};

export function AgentWorkComposer(props: AgentWorkComposerProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    const text = draft.trim();
    if (!text || sending || props.streaming) return;
    setSending(true);
    setError('');
    try {
      await props.onSend(text);
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
  return (
    <section className="agent-work-composer" aria-label="작업 대화 입력">
      {error && <p className="agent-work-message-error" role="alert">{error}</p>}
      <div><textarea aria-label="작업 대화 메시지" rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder="방향을 바꾸거나, 결과를 수정하거나, 다음 행동을 요청하세요" /><button type="button" aria-label="작업 대화에 보내기" disabled={!draft.trim() || sending || props.streaming} onClick={() => void submit()}>{sending ? '전송 중' : props.streaming ? '응답 중' : '보내기'}</button></div>
      <small>Enter로 전송 · Shift+Enter로 줄바꿈</small>
    </section>
  );
}
