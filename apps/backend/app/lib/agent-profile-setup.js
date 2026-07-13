const { resolveOfficialProfileName } = require('./official-profiles');

const PROFILE_TITLES = {
  default: 'Default Hermes',
  bizconsultant: 'Business Consultant',
  stockagent: 'Stock Agent',
  uniportpm: 'UniPort PM',
  wikicurator: 'Wiki Curator',
};

const PROFILE_MISSIONS = {
  default: 'Route general Hermes work, keep user-level memory clean, and hand off domain-specific work to the right profile.',
  bizconsultant: 'Research markets, business models, competitive signals, and product opportunities with source discipline.',
  stockagent: 'Track market evidence, publishing checks, and finance-oriented summaries with source discipline.',
  uniportpm: 'Manage UniPort product scope, backlog, prioritization, handoff, and final user reports.',
  wikicurator: 'Maintain the personal wiki, preserve source context, and produce reusable knowledge without inventing facts.',
};

const PROFILE_OWNS = {
  default: ['general triage', 'profile routing', 'Hermes summary reports'],
  bizconsultant: ['market research', 'business strategy', 'competitive evidence'],
  stockagent: ['market evidence', 'publishing verification', 'risk notes'],
  uniportpm: ['backlog 생성 및 prioritization', 'scope 관리 및 handoff', '최종 사용자 보고서 작성'],
  wikicurator: ['wiki retrieval', 'source-linked synthesis', 'knowledge maintenance'],
};

const PROFILE_AVOIDS = {
  default: ['domain memory mixing', 'inventing unavailable profile capabilities'],
  bizconsultant: ['stockagent finance memory', 'direct code implementation', 'unsupported external actions'],
  stockagent: ['marketing-only decisions without evidence', 'UniPort PM backlog ownership'],
  uniportpm: ['직접 코드 구현', '다른 도메인 memory 혼합'],
  wikicurator: ['unsupported claims', 'source deletion', 'unapproved publishing'],
};

function soulTemplate(profile) {
  const title = PROFILE_TITLES[profile] || profile;
  const owns = PROFILE_OWNS[profile] || PROFILE_OWNS.default;
  const avoids = PROFILE_AVOIDS[profile] || PROFILE_AVOIDS.default;
  const mission = PROFILE_MISSIONS[profile] || PROFILE_MISSIONS.default;
  return [
    `# ${title}`,
    '',
    `You are the ${title}.`,
    '',
    '## Mission',
    mission,
    '',
    '## Owns',
    ...owns.map((item) => `- ${item}`),
    '',
    '## Avoids',
    ...avoids.map((item) => `- ${item}`),
    '',
    '## Memory Scope',
    `- ${title}: 접두사 사용`,
    '- User:',
    '- Hermes:',
    '',
    '## Kanban Behavior',
    '- Triage 카드를 Ready로 승격',
    '- Running 상태에서는 profile이 claim한 카드만 처리',
    '- Blocked 상태일 때는 정확한 의존성 명시',
    '- 완료 시 증거(파일 경로, 스크린샷, 테스트 결과) 첨부',
    '',
    '## Verification',
    '작업 완료 전 반드시 파일 존재 여부와 테스트 통과 여부를 확인한다.',
  ].join('\n');
}

function buildAgentProfileSetup(profileName) {
  const profile = resolveOfficialProfileName(profileName);
  const profileRoot = `~/.hermes/profiles/${profile}`;
  return {
    profile,
    profileRoot,
    createCommand: profile === 'default'
      ? 'hermes profile use default'
      : `hermes profile create ${profile} --clone --clone-from default`,
    soul: {
      path: `${profileRoot}/SOUL.md`,
      template: soulTemplate(profile),
    },
    gateway: {
      setupCommand: 'hermes gateway setup',
      chatCompletionsPath: '/v1/chat/completions',
      profileParam: 'profile',
      routing: 'central gateway routes requests by profile parameter',
    },
    dashboard: {
      command: 'hermes dashboard --host 127.0.0.1 --port 9119 --no-open',
      localUrl: 'http://127.0.0.1:9119/',
      remoteHint: 'Expose through Tailscale Serve when remote access is needed.',
    },
    kanban: {
      initCommand: 'hermes kanban init',
      createCommand: `hermes kanban create "UniPort MVP 기획" --assignee ${profile} --status Triage`,
      listCommand: 'hermes kanban list',
      assignee: profile,
      flow: ['Triage', 'Ready', 'Running', 'Done', 'Blocked'],
    },
  };
}

module.exports = {
  buildAgentProfileSetup,
};
