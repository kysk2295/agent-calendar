const { resolveRequestedOfficialProfile } = require('./official-profiles');

const DEFAULT_STOP_CONDITIONS = [
  'cost or time guard exceeded',
  'same error repeats 3 times',
  'destructive action requires explicit approval',
  'sensitive data risk detected',
];

const MISSION_TEMPLATES = [
  {
    id: 'research-day',
    label: 'Research day loop',
    description: '논문을 읽고 가설, 실험 설계, 결과 정리를 하루 단위로 반복합니다.',
    agent: 'default',
    model: 'Codex',
    modelReason: 'Codex is preferred for code, experiment design, repo work, and long structured runs.',
    durationHours: 12,
    cadence: 'checkpoint every 60 minutes',
    defaultGoal: '논문을 읽고 가설을 뽑은 뒤 하루종일 실험 루프를 돌리고 결과를 LLM-Wiki에 정리',
    successCriteria: [
      'source papers and assumptions are summarized',
      'experiment plan and runnable next steps are written',
      'observations are appended to the agent-run file',
      'durable conclusions are promoted to LLM-Wiki candidates',
    ],
    wikiWriteBack: '5_conversation/agent-runs plus 3_output summary plus 2_wiki promotion candidates',
  },
  {
    id: 'remote-ops',
    label: 'Remote Mac mini ops',
    description: '원격 Mac mini의 Hermes 작업 상태를 이어받아 실행, 점검, 기록합니다.',
    agent: 'default',
    model: 'Codex',
    modelReason: 'Codex is preferred for terminal-driven local automation and codebase-aware task continuation.',
    durationHours: 8,
    cadence: 'checkpoint every 30 minutes',
    defaultGoal: '원격 Mac mini에서 진행 중인 Hermes 작업을 확인하고 끊긴 작업을 이어서 처리',
    successCriteria: [
      'current running jobs and blockers are identified',
      'safe queued work is continued without human approval',
      'handover notes are written for every pause',
      'runtime state and LLM-Wiki stay in sync',
    ],
    wikiWriteBack: '5_conversation/agent-runs and 7_automation/failures when paused',
  },
  {
    id: 'wiki-maintenance',
    label: 'LLM-Wiki maintenance',
    description: '세션 로그, 산출물, 반복 규칙을 정리해 어디서든 이어갈 수 있게 만듭니다.',
    agent: 'default',
    model: 'Claude Opus',
    modelReason: 'Claude Opus is preferred for synthesis, editing, taxonomy, and long-form wiki cleanup.',
    durationHours: 4,
    cadence: 'checkpoint every 45 minutes',
    defaultGoal: 'LLM-Wiki의 agent-run, output, rule 후보를 정리하고 다음 작업 진입점을 갱신',
    successCriteria: [
      'raw run logs remain in 5_conversation',
      'durable knowledge is promoted only after save filter',
      'backlog and log.md point to latest continuation path',
      'agent profiles receive reusable learning notes',
    ],
    wikiWriteBack: '2_wiki/dev-tasks, 5_conversation/handovers, 6_agents/rules',
  },
  {
    id: 'content-pipeline',
    label: 'Content pipeline',
    description: '리서치, 스크립트, 이미지/영상 제작 체크리스트를 연결합니다.',
    agent: 'default',
    model: 'Recommended',
    modelReason: 'Recommended routes planning to Claude-style synthesis and implementation to Codex-style execution.',
    durationHours: 6,
    cadence: 'checkpoint every 45 minutes',
    defaultGoal: '콘텐츠 아이디어를 리서치하고 스크립트와 제작 체크리스트를 만들어 위키에 연결',
    successCriteria: [
      'brief and audience are explicit',
      'script or storyboard draft is produced',
      'assets and follow-up tasks are linked',
      'publish checklist is saved',
    ],
    wikiWriteBack: '3_output drafts plus 2_wiki/content decisions',
  },
  {
    id: 'product-build',
    label: 'Product build sprint',
    description: '제품 요구사항을 테스트, 구현, 검증, 위키 기록으로 끝까지 밀어붙입니다.',
    agent: 'uniportpm',
    model: 'Codex',
    modelReason: 'Codex is preferred for test-driven implementation and local runtime verification.',
    durationHours: 10,
    cadence: 'checkpoint after every verified slice',
    defaultGoal: 'Hermes OS 제품 기능을 TDD로 구현하고 브라우저에서 검증한 뒤 LLM-Wiki에 기록',
    successCriteria: [
      'failing tests are observed before implementation',
      'runtime API and browser UI are both verified',
      'wiki handover records what changed and what remains',
      'next product slice is clear',
    ],
    wikiWriteBack: 'docs/superpowers/plans plus 5_conversation/agent-runs plus 2_wiki/dev-tasks',
  },
];

function cloneTemplate(template) {
  return {
    ...template,
    successCriteria: [...template.successCriteria],
  };
}

function listMissionTemplates() {
  return MISSION_TEMPLATES.map(cloneTemplate);
}

function getMissionTemplate(templateId) {
  const template = MISSION_TEMPLATES.find((item) => item.id === templateId);
  if (!template) {
    throw new Error(`Unknown mission template: ${templateId || 'missing'}`);
  }
  return template;
}

function normalizeDurationHours(value, fallback) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return fallback;
  return Math.min(Math.max(Math.round(duration), 1), 24);
}

function resolveModel({ requestedModel, template }) {
  if (requestedModel && requestedModel !== 'Recommended') return requestedModel;
  if (template.model !== 'Recommended') return template.model;
  return 'Recommended';
}

function buildMissionRunPayload(input = {}) {
  const template = getMissionTemplate(input.templateId);
  const userGoal = String(input.goal || template.defaultGoal).trim();
  const durationHours = normalizeDurationHours(input.durationHours, template.durationHours);
  const successCriteria = Array.isArray(input.successCriteria) && input.successCriteria.length
    ? input.successCriteria.map(String)
    : [...template.successCriteria];
  const stopConditions = Array.isArray(input.stopConditions) && input.stopConditions.length
    ? input.stopConditions.map(String)
    : [...DEFAULT_STOP_CONDITIONS];
  const wikiWriteBack = input.wikiWriteBack || template.wikiWriteBack;
  const agent = resolveRequestedOfficialProfile({
    agentId: input.agentId,
    agent: input.agent,
    fallback: template.agent,
  });
  const model = resolveModel({ requestedModel: input.model, template });
  const toolsets = Array.isArray(input.toolsets)
    ? input.toolsets.map(String).filter((toolset) => /^[a-z0-9_-]+$/i.test(toolset)).slice(0, 8)
    : [];
  const yolo = input.yolo !== false;
  const timeoutMs = Number(input.timeoutMs);
  const deadlineAt = Number.isFinite(new Date(input.deadlineAt).getTime())
    ? new Date(input.deadlineAt).toISOString()
    : '';

  const expandedGoal = [
    `Mission: ${template.label}`,
    `User goal: ${userGoal}`,
    `Recommended execution: run for up to ${durationHours}h, ${template.cadence}, no human approval unless a stop condition is hit.`,
    `Model routing: ${model}. ${template.modelReason}`,
    `LLM-Wiki write-back: ${wikiWriteBack}`,
    'Success criteria:',
    ...successCriteria.map((item) => `- ${item}`),
    'Stop conditions:',
    ...stopConditions.map((item) => `- ${item}`),
  ].join('\n');

  return {
    name: `${template.id} ${userGoal}`,
    goal: expandedGoal,
    agent,
    model,
    source: input.source || 'mission',
    noApproval: input.noApproval === undefined ? yolo : Boolean(input.noApproval),
    yolo,
    ...(toolsets.length ? { toolsets } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs >= 1_000 ? { timeoutMs: Math.round(timeoutMs) } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    mission: {
      id: template.id,
      label: template.label,
      durationHours,
      cadence: template.cadence,
      wikiWriteBack,
      recommendedModelReason: template.modelReason,
    },
    successCriteria,
    stopConditions,
    wikiWriteBack,
  };
}

function buildMissionSchedulePayload(input = {}) {
  const template = getMissionTemplate(input.templateId);
  const runPayload = buildMissionRunPayload(input);
  const intervalMinutes = Number(input.intervalMinutes) || 60;
  return {
    name: input.name || `${template.id} mission`,
    goal: runPayload.goal,
    agent: runPayload.agent,
    model: runPayload.model,
    intervalMinutes: Math.max(1, Math.round(intervalMinutes)),
    enabled: input.enabled !== false,
  };
}

module.exports = {
  buildMissionRunPayload,
  buildMissionSchedulePayload,
  listMissionTemplates,
};
