'use strict';

function modelConfig(env = process.env) {
  const cloudEnabled = !/^(0|false|off|no)$/i.test(String(
    env.CALENDAR_AI_CLOUD_MODEL_ENABLED ?? '1',
  ));
  const apiKey = String(
    env.OPENAI_API_KEY
    || env.HERMES_OPENAI_API_KEY
    || env.AGENT_CALENDAR_OPENAI_API_KEY
    || '',
  ).trim();
  const baseUrl = String(
    env.OPENAI_BASE_URL
    || env.HERMES_OPENAI_BASE_URL
    || env.AGENT_CALENDAR_OPENAI_BASE_URL
    || 'https://api.openai.com/v1',
  ).trim().replace(/\/+$/g, '');
  const model = String(
    env.OPENAI_CHAT_MODEL
    || env.HERMES_OPENAI_CHAT_MODEL
    || env.AGENT_CALENDAR_OPENAI_MODEL
    || 'gpt-4o-mini',
  ).trim();
  return { cloudEnabled, apiKey, baseUrl, model };
}

function createCalendarAiModelAdapter({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async complete(input = {}) {
      const messages = Array.isArray(input.messages) ? input.messages : [];
      const config = modelConfig(env);
      if (!config.cloudEnabled) {
        const error = new Error('Agent Calendar Cloud AI is disabled');
        error.code = 'AGENT_CALENDAR_CLOUD_AI_DISABLED';
        throw error;
      }
      if (!config.apiKey || typeof fetchImpl !== 'function') {
        const error = new Error('Agent Calendar Cloud AI credentials are not configured');
        error.code = 'AGENT_CALENDAR_CLOUD_AI_UNAVAILABLE';
        throw error;
      }
      const controller = new AbortController();
      const timeoutMs = Math.max(
        1_000,
        Number(env.CALENDAR_AI_MODEL_TIMEOUT_MS || 25_000),
      );
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0.4,
            max_tokens: 900,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`Agent Calendar Cloud AI request failed (${response.status})`);
          error.code = 'AGENT_CALENDAR_CLOUD_AI_FAILED';
          throw error;
        }
        const payload = await response.json();
        const text = String(payload?.choices?.[0]?.message?.content || '').trim();
        if (!text) {
          const error = new Error('Agent Calendar Cloud AI returned an empty answer');
          error.code = 'AGENT_CALENDAR_CLOUD_AI_EMPTY';
          throw error;
        }
        return {
          text,
          provider: 'agent-calendar-cloud',
          model: config.model,
        };
      } catch (error) {
        if (error && error.name === 'AbortError') {
          const timeout = new Error('Agent Calendar Cloud AI timed out');
          timeout.code = 'AGENT_CALENDAR_CLOUD_AI_TIMEOUT';
          throw timeout;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  createCalendarAiModelAdapter,
  modelConfig,
};
