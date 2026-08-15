'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendWikiLog,
  dateStamp,
  ensureWikiStructure,
  slugify,
} = require('./wiki');
const { safePublicText } = require('./runtime-gateway');

const ARCHIVE_DIR = '5_conversation/agent-runs';
const MAX_FINDINGS = 8;
const MAX_TASKS = 24;
const MAX_MEMORY_PINS = 3;
const MAX_MEMORY_PIN_LENGTH = 200;

function cleanText(value, maximumLength = 2_000) {
  // Archives keep redaction markers so owners still see structure without secrets/paths.
  return safePublicText(value, '', maximumLength, { preserveRedactions: true });
}

function redactWorkResultText(value) {
  return String(value || '').normalize('NFKC')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:accessToken|refreshToken|runtimeToken|apiKey|api_key|clientSecret|credential|password|secret|token)\s*[:=]\s*([^\s,"'}]+)/gi, 'credential=[REDACTED]')
    .replace(/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|hf_[A-Za-z0-9]{16,}|(?:gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/(?:file:\/\/)?\/(?:Users|home|Volumes|private|var\/folders|tmp|Library|System|Applications|etc|opt|usr\/local)\/[^\s"'}]+/g, '[PRIVATE_PATH]');
}

function workResultCitations(citations = []) {
  const unique = new Map();
  for (const citation of Array.isArray(citations) ? citations : []) {
    const handle = cleanText(citation?.handle, 400);
    const label = cleanText(citation?.label, 240);
    if (handle && label && !unique.has(handle)) unique.set(handle, { handle, label });
  }
  return [...unique.values()];
}

function workResultArtifacts(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : []).flatMap((artifact) => {
    const id = cleanText(artifact?.id, 200);
    const name = cleanText(artifact?.name, 240);
    if (!id || !name) return [];
    return [{
      id,
      name,
      contentType: cleanText(artifact?.contentType || artifact?.content_type, 120),
      ...(artifact?.contentDigest ? { contentDigest: cleanText(artifact.contentDigest, 128) } : {}),
    }];
  });
}

function completedWorkResultId(workspaceId, missionId, reportId) {
  const identity = [workspaceId, missionId, reportId].map(String).join('\u0000');
  return `work_result_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 28)}`;
}

function buildCompletedWorkResultProjection({
  workspaceId = '',
  mission = {},
  report = {},
  artifacts = null,
} = {}) {
  const missionId = cleanText(mission?.id, 200);
  const reportId = cleanText(report?.id, 200);
  const currentReportId = cleanText(mission?.currentResultReportId, 200);
  if (!workspaceId
    || !missionId
    || mission?.status !== 'completed'
    || !reportId
    || report?.status !== 'ready'
    || currentReportId !== reportId
    || (mission?.workspaceId && mission.workspaceId !== workspaceId)
    || (report?.workspaceId && report.workspaceId !== workspaceId)
    || (report?.missionId && report.missionId !== missionId)) {
    return null;
  }
  const workResultId = completedWorkResultId(workspaceId, missionId, reportId);
  const title = cleanText(report.title || mission.title || missionId, 240) || 'Work result';
  const finalText = redactWorkResultText(
    report.fullText
    || report.resultText
    || report.markdown
    || report.resultSummary
    || report.summary
    || '',
  ).trim();
  const citations = workResultCitations(report.citations);
  const normalizedArtifacts = workResultArtifacts(artifacts || report.artifacts);
  const workConversationId = cleanText(
    mission.workConversationId || mission.missionThreadId || report.sessionId,
    200,
  );
  const completedAt = new Date(
    mission.completedAt || report.completedAt || report.updatedAt || report.createdAt || Date.now(),
  ).toISOString();
  const relativePath = `${ARCHIVE_DIR}/${workResultId}.md`;
  const citationLines = citations.length
    ? citations.map((citation) => `- [${citation.label}](${citation.handle})`).join('\n')
    : '- (원본 citation 없음)';
  const artifactLines = normalizedArtifacts.length
    ? normalizedArtifacts.map((artifact) => `- ${artifact.name} (${artifact.id})`).join('\n')
    : '- (artifact 없음)';
  const markdown = [
    '---',
    'type: work-result',
    `work_result_id: ${workResultId}`,
    `mission_id: ${missionId}`,
    `work_conversation_id: ${workConversationId}`,
    `report_id: ${reportId}`,
    'status: completed',
    'source: agent-calendar',
    '---',
    '',
    `# ${title}`,
    '',
    '## Citations',
    '',
    citationLines,
    '',
    '## Artifacts',
    '',
    artifactLines,
    '',
    '## Final result',
    '',
    finalText,
  ].join('\n');
  return {
    workResultId,
    missionId,
    workConversationId,
    reportId,
    title,
    status: 'completed',
    completedAt,
    finalText,
    citations,
    artifacts: normalizedArtifacts,
    contentDigest: crypto.createHash('sha256').update(markdown).digest('hex'),
    wiki: {
      status: 'pending_local',
      projectionId: `work-result-wiki:${workResultId}`,
      relativePath,
      markdown,
    },
  };
}

function listLines(items = [], maximum = 12) {
  const lines = (Array.isArray(items) ? items : [])
    .map((item) => cleanText(item, 800))
    .filter(Boolean)
    .slice(0, maximum);
  if (!lines.length) return '- (없음)';
  return lines.map((line) => `- ${line}`).join('\n');
}

function taskLines(tasks = []) {
  const lines = (Array.isArray(tasks) ? tasks : [])
    .slice(0, MAX_TASKS)
    .map((task) => {
      const title = cleanText(task?.title || task?.id, 200) || 'untitled-task';
      const status = cleanText(task?.status, 40) || 'unknown';
      const actionClass = cleanText(task?.actionClass, 40);
      return actionClass
        ? `- [${status}] ${title} (${actionClass})`
        : `- [${status}] ${title}`;
    });
  return lines.length ? lines.join('\n') : '- (하위 작업 없음)';
}

function buildDelegatedWorkArchiveMarkdown({
  mission = {},
  report = null,
  tasks = [],
  agentId = '',
  now = new Date(),
} = {}) {
  const date = dateStamp(now);
  const title = cleanText(mission.title || report?.title || mission.id, 200) || 'delegated-work';
  const objective = cleanText(mission.objective || mission.planSummary, 4_000) || '(목표 없음)';
  const status = cleanText(mission.status, 40) || 'completed';
  const resolvedAgent = cleanText(agentId || mission.agentId, 80) || 'unknown';
  const reportTitle = cleanText(report?.title, 200);
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const limitations = Array.isArray(report?.limitations) ? report.limitations : [];
  const followUps = Array.isArray(report?.followUps)
    ? report.followUps.map((item) => item?.title || item?.reason || item).filter(Boolean)
    : [];

  return [
    '---',
    'type: delegated-work-archive',
    `date: ${date}`,
    `status: ${status}`,
    `mission_id: ${cleanText(mission.id, 120)}`,
    `report_id: ${cleanText(report?.id, 120)}`,
    `agent: ${resolvedAgent}`,
    'source: agent-calendar',
    '---',
    '',
    `# ${title}`,
    '',
    '## Goal',
    '',
    objective,
    '',
    '## Outcome',
    '',
    `- mission_status: ${status}`,
    `- agent: ${resolvedAgent}`,
    `- report: ${reportTitle || '(no report title)'}`,
    `- completed_at: ${dateStamp(now)}`,
    '',
    '## Findings',
    '',
    listLines(findings, MAX_FINDINGS),
    '',
    '## Limitations',
    '',
    listLines(limitations, 6),
    '',
    '## Follow-ups (manual)',
    '',
    listLines(followUps, 6),
    '',
    '## Subordinate tasks',
    '',
    taskLines(tasks),
    '',
    '## Resume',
    '',
    '- This note is an automatic archive of completed Delegated Work.',
    '- Promote durable facts into agent memory only after user confirmation.',
    '- Create Follow-up Work for materially different goals.',
    '',
  ].join('\n');
}

function proposeAgentMemoryPins({ mission = {}, report = null } = {}) {
  const candidates = [];
  const push = (raw) => {
    const text = cleanText(raw, MAX_MEMORY_PIN_LENGTH);
    if (!text) return;
    if (candidates.some((item) => item.toLowerCase() === text.toLowerCase())) return;
    if (candidates.length >= MAX_MEMORY_PINS) return;
    candidates.push(text);
  };

  for (const finding of Array.isArray(report?.findings) ? report.findings : []) {
    push(finding);
  }
  if (candidates.length < MAX_MEMORY_PINS) {
    const objective = cleanText(mission.objective || mission.title, MAX_MEMORY_PIN_LENGTH);
    if (objective) {
      push(`완료한 위임 작업 맥락: ${objective}`);
    }
  }
  return candidates.slice(0, MAX_MEMORY_PINS);
}

function archiveRelativePath({ mission = {}, report = null, now = new Date() } = {}) {
  const date = dateStamp(now);
  const slug = slugify(mission.title || report?.title || mission.id || 'delegated-work', 'delegated-work');
  const missionToken = cleanText(mission.id, 40).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 24) || 'work';
  return `${ARCHIVE_DIR}/${date}-${slug}-${missionToken}.md`;
}

function writeDelegatedWorkArchive({
  wikiRoot = '',
  mission = {},
  report = null,
  tasks = [],
  agentId = '',
  now = new Date(),
} = {}) {
  const markdown = buildDelegatedWorkArchiveMarkdown({
    mission,
    report,
    tasks,
    agentId,
    now,
  });
  const relativePath = archiveRelativePath({ mission, report, now });
  const archivedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const pins = proposeAgentMemoryPins({ mission, report });

  if (!wikiRoot || !String(wikiRoot).trim()) {
    return {
      status: 'skipped_no_wiki',
      relativePath: '',
      archivedAt,
      proposedMemoryPins: pins,
      markdown,
    };
  }

  try {
    ensureWikiStructure(wikiRoot);
    const absolutePath = path.join(wikiRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, markdown, 'utf8');
    appendWikiLog({
      wikiRoot,
      date: dateStamp(now),
      intent: 'delegated-work-archive',
      message: relativePath,
    });
    return {
      status: 'written',
      relativePath,
      archivedAt,
      proposedMemoryPins: pins,
      markdown,
    };
  } catch (error) {
    return {
      status: 'failed',
      relativePath: '',
      archivedAt,
      proposedMemoryPins: pins,
      markdown,
      errorCode: error?.code || 'wiki_archive_failed',
      errorMessage: cleanText(error?.message, 200) || 'wiki archive failed',
    };
  }
}

function shouldArchiveCompletedMission(mission = {}, report = null) {
  if (!mission || mission.status !== 'completed') return false;
  if (!report || report.status !== 'ready') return false;
  if (mission.wikiArchive?.status === 'written'
    && mission.wikiArchive?.reportId
    && mission.wikiArchive.reportId === report.id) {
    return false;
  }
  return true;
}

function archiveCompletedDelegatedWork({
  store,
  missionId,
  wikiRoot = '',
  clock = () => new Date(),
} = {}) {
  if (!store || !missionId) return null;
  const state = store.getState();
  const mission = state.agentMissions.find((item) => item.id === missionId);
  if (!mission) return null;
  const report = state.agentReports.find((item) => (
    item.id === mission.currentResultReportId
    && item.missionId === mission.id
    && item.status === 'ready'
  ));
  if (!shouldArchiveCompletedMission(mission, report)) {
    return mission.wikiArchive || null;
  }

  const tasks = state.tasks.filter((task) => (
    task.missionId === mission.id && task.origin === 'agent'
  ));
  const now = clock();
  const archive = writeDelegatedWorkArchive({
    wikiRoot,
    mission,
    report,
    tasks,
    agentId: mission.agentId,
    now,
  });

  const wikiArchive = {
    status: archive.status,
    relativePath: archive.relativePath || '',
    archivedAt: archive.archivedAt,
    reportId: report.id,
    ...(archive.errorCode ? { errorCode: archive.errorCode } : {}),
  };
  const proposedMemoryPins = archive.proposedMemoryPins || [];
  const updated = store.updateAgentMission(mission.id, {
    wikiArchive,
    proposedMemoryPins,
  });

  const missionThread = state.agentSessions.find((session) => (
    session.id === mission.missionThreadId
    && session.missionId === mission.id
    && session.type === 'mission-thread'
  ));
  if (missionThread) {
    const { sanitizeSessionEvent } = require('./agent-operations-domain');
    let text = '위임 작업 결과를 위키에 자동 보관했습니다.';
    if (archive.status === 'skipped_no_wiki') {
      text = '위임 작업은 완료됐지만 위키 루트가 설정되지 않아 자동 보관을 건너뛰었습니다.';
    } else if (archive.status === 'failed') {
      text = '위임 작업은 완료됐지만 위키 자동 보관에 실패했습니다.';
    }
    store.appendAgentSessionEvent(missionThread.id, sanitizeSessionEvent({
      kind: 'artifact',
      text,
      createdAt: archive.archivedAt,
      metadata: {
        wikiArchiveStatus: archive.status,
        // Avoid keys matching redactSessionValue's /path/ filter (e.g. *Path).
        wikiArchiveNote: archive.relativePath || '',
        reportId: report.id,
        proposedMemoryPinCount: proposedMemoryPins.length,
      },
    }));
  }

  return {
    mission: updated,
    wikiArchive,
    proposedMemoryPins,
  };
}

module.exports = {
  ARCHIVE_DIR,
  archiveCompletedDelegatedWork,
  archiveRelativePath,
  buildCompletedWorkResultProjection,
  buildDelegatedWorkArchiveMarkdown,
  proposeAgentMemoryPins,
  shouldArchiveCompletedMission,
  writeDelegatedWorkArchive,
};
