const crypto = require('node:crypto');

function createId(prefix, createdAt = new Date().toISOString()) {
  const suffix = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `${prefix}-${createdAt.slice(0, 10)}-${suffix}`;
}

function createReflection({ run, note, outcome = 'success', createdAt = new Date().toISOString() }) {
  const isSuccess = outcome === 'success' || run.status === 'done';
  return {
    id: createId('reflection', createdAt),
    runId: run.id,
    run: run.name,
    agent: run.agent,
    outcome,
    note,
    target: isSuccess ? '6_agents/skills' : '7_automation/failures',
    nextAction: isSuccess ? 'Create skill promotion candidate after reviewer pass' : 'Create failure guard and update agent rule',
    createdAt,
  };
}

function createSkillCandidate({ name, evidence, score, successfulRuns = 0, target = '6_agents/skills' }) {
  return {
    id: createId('skill', new Date().toISOString()),
    name,
    evidence,
    score: Number(score),
    successfulRuns: Number(successfulRuns),
    target,
    status: shouldPromoteSkill({ score, successfulRuns }) ? 'ready' : 'watch',
  };
}

function shouldPromoteSkill(candidate) {
  return Number(candidate.score) >= 85 && Number(candidate.successfulRuns) >= 3;
}

module.exports = {
  createReflection,
  createSkillCandidate,
  shouldPromoteSkill,
};
