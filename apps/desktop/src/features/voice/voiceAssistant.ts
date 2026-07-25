type VoiceMessage = {
  readonly role: string;
  readonly text: string;
};

export function buildMorningBriefingPrompt(now = new Date()): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return [
    `${date} Asia/Seoul 기준 아침 브리핑을 해줘.`,
    '오늘 일정과 미완료 할 일을 시간순으로 짧게 정리하고,',
    '가장 중요한 우선순위 3개, 일정 충돌이나 촉박한 이동, 활용 가능한 빈 시간을 알려줘.',
    '마지막에는 지금 바로 시작할 첫 행동 하나를 제안해줘.',
    '운전하거나 준비하면서 들을 수 있게 자연스러운 한국어 구어체로 답해줘.',
  ].join(' ');
}

export function latestAssistantSpeech(messages: readonly VoiceMessage[]): string {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.text.trim())
    ?.text.trim() || '';
}
