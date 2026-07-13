const { routeWebCommand } = require('./commands');
const { resolveOfficialProfileName } = require('./official-profiles');
const { dateStamp, slugify } = require('./wiki');

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMultiline(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function resolveWorkboardAgent(text, route) {
  if (/논문|paper|research|실험|experiment|hypothesis|rag/i.test(text)) return 'default';
  if (/코딩|개발|구현|버그|테스트|deploy|배포|code|coding|api/i.test(text)) return 'uniportpm';
  if (/메일|공유|게시|콘텐츠|영상|shorts|blog|email|publish/i.test(text)) return 'default';
  return resolveOfficialProfileName(route.agent);
}

function buildSuccessCriteria(text) {
  const criteria = [
    'Workboard source context is converted into clear execution steps',
    'Run pauses for approval before any side-effecting action',
    'Result summary, artifacts, and resume notes are written to LLM-Wiki',
  ];
  if (/논문|paper|research|실험|experiment|hypothesis|rag/i.test(text)) {
    criteria.push('Paper claims, experiment setup, and measured results are separated');
  }
  if (/코딩|개발|구현|테스트|deploy|배포|code|coding|api/i.test(text)) {
    criteria.push('Implementation, verification commands, and remaining risks are recorded');
  }
  return criteria;
}

function buildWorkboardTaskDraft({
  title,
  content,
  selectedDate = new Date().toISOString().slice(0, 10),
  model = 'Codex',
} = {}) {
  const safeTitle = compact(title);
  if (!safeTitle) throw new Error('title is required');
  const safeContent = normalizeMultiline(content);
  const combined = [safeTitle, safeContent].filter(Boolean).join('\n');
  const route = routeWebCommand({ message: combined, view: 'workboard' });
  const agent = resolveWorkboardAgent(combined, route);
  const date = selectedDate || new Date().toISOString().slice(0, 10);
  return {
    title: safeTitle,
    originalText: combined,
    content: safeContent,
    owner: 'Agent',
    status: 'Queued',
    date,
    time: '',
    agent,
    model: model || 'Codex',
    routeTemplateId: route.templateId || 'workboard-execution',
    successCriteria: buildSuccessCriteria(combined),
    wikiDestination: '5_conversation/agent-runs',
    actions: ['Create', 'Run now'],
    source: 'workboard',
    priority: /긴급|urgent|today|오늘|배포|장애/i.test(combined) ? 'high' : 'medium',
    tags: ['workboard', agent.toLowerCase()],
    project: 'Hermes OS',
  };
}

function buildWorkboardRunPayload(draft, { now = new Date() } = {}) {
  const date = draft.date || dateStamp(now);
  const wikiFile = `5_conversation/agent-runs/${date}-${slugify(draft.title, 'workboard-run')}.md`;
  return {
    name: draft.title,
    goal: [
      `Workboard note: ${draft.title}`,
      `Agent: ${draft.agent}`,
      `Model: ${draft.model}`,
      `LLM-Wiki write-back: ${draft.wikiDestination}`,
      `Exact result file: ${wikiFile}`,
      'Do not perform side effects without explicit human approval.',
      'Source context:',
      draft.content || draft.originalText || draft.title,
      'Success criteria:',
      ...(draft.successCriteria || []).map((item) => `- ${item}`),
    ].join('\n'),
    file: wikiFile,
    agent: draft.agent,
    model: draft.model || 'Codex',
    source: 'workboard',
    noApproval: false,
    successCriteria: draft.successCriteria || [],
    wikiWriteBack: wikiFile,
    mission: {
      id: draft.routeTemplateId || 'workboard-execution',
      label: 'Workboard execution',
      wikiWriteBack: wikiFile,
    },
  };
}

module.exports = {
  buildWorkboardRunPayload,
  buildWorkboardTaskDraft,
};
