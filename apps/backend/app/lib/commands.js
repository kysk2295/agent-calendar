const { resolveProductAgentName } = require('./official-profiles');

const COMMAND_ROUTES = [
  {
    templateId: 'research-day',
    agent: 'default',
    model: 'Codex',
    keywords: ['논문', 'paper', 'research', '실험', 'experiment', 'ablation', '가설'],
    reason: '논문/research/experiment keywords matched.',
  },
  {
    templateId: 'wiki-maintenance',
    agent: 'default',
    model: 'Codex',
    keywords: ['위키', 'wiki', '정리', 'handover', '메모리', '기억', '문서'],
    reason: 'wiki/knowledge maintenance keywords matched.',
  },
  {
    templateId: 'content-pipeline',
    agent: 'default',
    model: 'Recommended',
    keywords: ['콘텐츠', 'content', '영상', 'script', '스크립트', 'shorts', 'publish'],
    reason: 'content production keywords matched.',
  },
  {
    templateId: 'product-build',
    agent: 'uniportpm',
    model: 'Codex',
    keywords: ['개발', 'build', 'product', '프로덕트', '코드', 'tdd', '구현', '버그'],
    reason: 'product build keywords matched.',
  },
];

const FALLBACK_ROUTE = {
  templateId: 'remote-ops',
  agent: 'default',
  model: 'Codex',
  reason: 'No specific command keyword matched, so Hermes will continue remote operations.',
};

function normalizeMessage(value) {
  return String(value || '').trim();
}

function findRoute(message) {
  const lower = message.toLowerCase();
  return COMMAND_ROUTES.find((route) => route.keywords.some((keyword) => lower.includes(keyword.toLowerCase())))
    || FALLBACK_ROUTE;
}

function routeWebCommand({ message, view, agent, agentId } = {}) {
  const normalizedMessage = normalizeMessage(message);
  if (!normalizedMessage) {
    throw new Error('message is required');
  }
  const route = findRoute(normalizedMessage);
  const selectedAgent = resolveProductAgentName({ agentId, agent, fallback: route.agent }) || route.agent;
  return {
    message: normalizedMessage,
    view: view || '',
    templateId: route.templateId,
    agent: selectedAgent,
    model: route.model,
    source: 'web-command',
    reason: route.reason,
  };
}

module.exports = {
  COMMAND_ROUTES,
  routeWebCommand,
};
