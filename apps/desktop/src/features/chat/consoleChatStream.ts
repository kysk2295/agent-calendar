function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export async function consumeConsoleChatStream(
  response: Response,
  onText: (text: string) => void,
  onDone?: (payload: Record<string, unknown>) => void,
): Promise<string> {
  if (!response.ok || !response.body) throw new Error(`console stream ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let answer = '';

  const consume = (block: string) => {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim() || 'message';
    const raw = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!raw || raw === '[DONE]') return;
    const payload = record(JSON.parse(raw));
    if (event === 'error' && typeof payload.error === 'string' && payload.error) {
      throw new Error(payload.error);
    }
    const payloadType = typeof payload.type === 'string' ? payload.type : '';
    const effectiveEvent = event === 'message'
      ? (payloadType === 'token' ? 'delta' : payloadType)
      : event;
    if (effectiveEvent !== 'delta' && effectiveEvent !== 'done') return;
    if (typeof payload.text !== 'string' || !payload.text) return;
    if (effectiveEvent === 'delta') answer += payload.text;
    if (effectiveEvent === 'done' && !answer) answer = payload.text;
    onText(answer);
    if (effectiveEvent === 'done') onDone?.(payload);
  };

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let separator = pending.indexOf('\n\n');
    while (separator >= 0) {
      consume(pending.slice(0, separator));
      pending = pending.slice(separator + 2);
      separator = pending.indexOf('\n\n');
    }
    if (done) break;
  }
  if (pending.trim()) consume(pending);
  if (!answer.trim()) throw new Error('console stream returned no answer');
  return answer;
}
