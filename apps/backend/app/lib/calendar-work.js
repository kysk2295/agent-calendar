const { routeWebCommand } = require('./commands');

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function resolveDate(text, selectedDate) {
  if (/내일|tomorrow/i.test(text)) return addDays(selectedDate, 1);
  if (/오늘|today/i.test(text)) return selectedDate;
  return selectedDate;
}

function resolveTime(text) {
  const koreanHour = text.match(/(오전|오후)\s*(\d{1,2})시/);
  if (koreanHour) {
    let hour = Number(koreanHour[2]);
    if (koreanHour[1] === '오후' && hour < 12) hour += 12;
    if (koreanHour[1] === '오전' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:00`;
  }
  const time = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (time) return `${String(Number(time[1])).padStart(2, '0')}:${time[2]}`;
  return '';
}

function resolveOwner(text) {
  if (/검토|확인|결정|review|approve|초안/i.test(text) && /에이전트|agent|시켜|맡/i.test(text)) {
    return 'Hybrid';
  }
  if (/에이전트|agent|시켜|맡|default|bizconsultant|stockagent|uniportpm|wikicurator|Codex|Claude|Grok/i.test(text)) return 'Agent';
  return 'Me';
}

function ownerStatus(owner) {
  if (owner === 'Agent') return 'Queued';
  if (owner === 'Hybrid') return 'Needs Review';
  return 'Planned';
}

function wikiDestination(owner) {
  if (owner === 'Me') return '2_wiki/projects';
  return '5_conversation/agent-runs';
}

function buildSuccessCriteria(owner) {
  const criteria = [
    'Goal and due date are explicit',
    'LLM-Wiki result or checkpoint is written',
  ];
  if (owner === 'Agent') {
    criteria.push('Agent run logs are visible in Runs');
  }
  if (owner === 'Hybrid') {
    criteria.push('Yunseo review point is explicit');
  }
  if (owner === 'Me') {
    criteria.push('Task can be completed or rescheduled by Yunseo');
  }
  return criteria;
}

function cleanTitle(text) {
  return String(text || '')
    .replace(/^\s*\/hermes\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCalendarWorkDraft({ text, selectedDate = new Date().toISOString().slice(0, 10) } = {}) {
  const title = cleanTitle(text);
  if (!title) throw new Error('text is required');
  const owner = resolveOwner(title);
  const route = routeWebCommand({ message: title, view: 'calendar' });
  return {
    title,
    originalText: String(text || ''),
    owner,
    status: ownerStatus(owner),
    date: resolveDate(title, selectedDate),
    time: resolveTime(title),
    agent: owner === 'Me' ? 'Yunseo' : route.agent,
    model: 'Codex',
    routeTemplateId: route.templateId,
    successCriteria: buildSuccessCriteria(owner),
    wikiDestination: wikiDestination(owner),
    actions: owner === 'Me' ? ['Create'] : ['Create', 'Schedule', 'Run now'],
  };
}

module.exports = {
  buildCalendarWorkDraft,
};
