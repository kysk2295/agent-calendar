import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

test('Voice Assistant builds a focused morning briefing request', async () => {
  const voice = await vite.ssrLoadModule('/src/features/voice/voiceAssistant.ts');
  const prompt = voice.buildMorningBriefingPrompt(new Date('2026-07-23T07:30:00+09:00'));

  assert.match(prompt, /2026-07-23/);
  assert.match(prompt, /Asia\/Seoul/);
  assert.match(prompt, /시간순/);
  assert.match(prompt, /우선순위/);
  assert.match(prompt, /충돌/);
  assert.match(prompt, /첫 행동/);
});

test('Voice Assistant selects only the final assistant answer for speech', async () => {
  const voice = await vite.ssrLoadModule('/src/features/voice/voiceAssistant.ts');

  assert.equal(voice.latestAssistantSpeech([
    { role: 'user', text: '오늘 브리핑해줘' },
    { role: 'assistant', text: '' },
  ]), '');
  assert.equal(voice.latestAssistantSpeech([
    { role: 'assistant', text: '이전 답변' },
    { role: 'user', text: '오늘 브리핑해줘' },
    { role: 'assistant', text: '오늘은 오전 10시 회의가 있습니다.' },
  ]), '오늘은 오전 10시 회의가 있습니다.');
});
