const { slugify } = require('./wiki');

function redactSensitiveText(value = '') {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|secret|token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(access_token=)[^&\s]+/gi, '$1redacted');
}

function escapeXml(value = '') {
  return redactSensitiveText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function trimText(value = '', max = 120) {
  const text = redactSensitiveText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function wrapText(value = '', maxChars = 52, maxLines = 3) {
  const text = trimText(value, maxChars * maxLines);
  if (!text) return [''];
  const lines = [];
  let remaining = text;
  while (remaining.length && lines.length < maxLines) {
    if (remaining.length <= maxChars) {
      lines.push(remaining);
      break;
    }
    const slice = remaining.slice(0, maxChars + 1);
    const breakAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('·'));
    const index = breakAt > 12 ? breakAt : maxChars;
    lines.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\.\.\.$/, '')}...`;
  return lines;
}

function statusTone(status = '') {
  const normalized = String(status || '').toLowerCase();
  if (/complete|done|success/.test(normalized)) return 'mint';
  if (/fail|error|blocked/.test(normalized)) return 'danger';
  if (/queue|planned|review/.test(normalized)) return 'amber';
  return 'blue';
}

function toneColor(tone) {
  return {
    mint: { bg: '#dff7ed', fg: '#13785a', line: '#9bd5be' },
    amber: { bg: '#f9ead2', fg: '#955d19', line: '#e2bd7e' },
    danger: { bg: '#f9ded8', fg: '#a6402f', line: '#da9b8f' },
    blue: { bg: '#ddebf7', fg: '#245d82', line: '#a8c8dd' },
    lav: { bg: '#e7e4ff', fg: '#6558bd', line: '#c0baf0' },
  }[tone] || { bg: '#f1e7d8', fg: '#5f544b', line: '#e5d8c5' };
}

function buildNextActions(status) {
  const normalized = String(status || '').toLowerCase();
  if (/complete|done|success/.test(normalized)) {
    return [
      'Review the wiki result and promote reusable steps if repeated.',
      'Share the visual brief or attach it to the next handover.',
    ];
  }
  if (/fail|error|blocked/.test(normalized)) {
    return [
      'Inspect the failed phase and retry with a narrower scope.',
      'Write a failure rule before restarting the agent.',
    ];
  }
  if (/queue|planned/.test(normalized)) {
    return [
      'Confirm schedule and let the resident daemon pick it up.',
      'Run now if this work should start immediately.',
    ];
  }
  return [
    'Watch heartbeat and latest activity.',
    'Let Hermes write checkpoints to LLM-Wiki.',
  ];
}

function buildCards(run, kind) {
  if (kind === 'task') {
    return [
      { label: 'Owner', value: run.owner || 'Me', tone: run.owner === 'Agent' ? 'mint' : 'blue' },
      { label: 'Agent', value: run.agent || 'Yunseo', tone: 'lav' },
      { label: 'Due', value: run.due || run.date || 'Unscheduled', tone: 'amber' },
      { label: 'Model', value: run.model || 'Codex', tone: 'blue' },
    ];
  }
  return [
    { label: 'Agent', value: run.agent || 'Hermes', tone: 'lav' },
    { label: 'Model', value: run.model || 'Codex', tone: 'blue' },
    { label: 'Source', value: run.source || 'web', tone: 'amber' },
    { label: 'Wiki', value: run.file || run.wikiWriteBack || 'pending', tone: 'mint' },
  ];
}

function buildTimeline(run) {
  const logs = Array.isArray(run.logs) && run.logs.length
    ? run.logs
    : ['run created', 'waiting for first checkpoint'];
  return logs.slice(-5).map((line, index) => ({
    label: String(index + 1).padStart(2, '0'),
    value: trimText(line, 98),
  }));
}

function textRows(lines, x, y, options = {}) {
  const size = options.size || 15;
  const weight = options.weight || 600;
  const color = options.color || '#352f28';
  const gap = options.gap || Math.round(size * 1.4);
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + index * gap}" fill="${color}" font-size="${size}" font-weight="${weight}">${escapeXml(line)}</text>`
  )).join('');
}

function renderVisualBriefSvg(brief) {
  const status = toneColor(brief.statusTone);
  const cardWidth = 190;
  const cards = brief.cards.map((card, index) => {
    const x = 40 + index * 210;
    const tone = toneColor(card.tone);
    return `<g>
      <rect x="${x}" y="174" width="${cardWidth}" height="84" rx="8" fill="${tone.bg}" stroke="${tone.line}"/>
      <text x="${x + 16}" y="206" fill="${tone.fg}" font-size="13" font-weight="800">${escapeXml(card.label)}</text>
      ${textRows(wrapText(card.value, 18, 2), x + 16, 233, { size: 18, weight: 800, color: '#352f28', gap: 20 })}
    </g>`;
  }).join('');

  const timeline = brief.timeline.map((item, index) => {
    const y = 322 + index * 32;
    return `<g>
      <circle cx="54" cy="${y - 5}" r="10" fill="#fffaf2" stroke="#d97959"/>
      <text x="48" y="${y}" fill="#bc654a" font-size="11" font-weight="800">${escapeXml(item.label)}</text>
      <text x="78" y="${y}" fill="#5f544b" font-size="14" font-weight="650">${escapeXml(item.value)}</text>
    </g>`;
  }).join('');

  const nextActions = brief.nextActions.slice(0, 2).map((item, index) => (
    `<text x="556" y="${334 + index * 34}" fill="#352f28" font-size="15" font-weight="700">${escapeXml(`- ${item}`)}</text>`
  )).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 520" role="img" aria-label="${escapeXml(brief.title)} Visual Brief">
    <rect width="920" height="520" rx="18" fill="#fffaf2"/>
    <rect x="22" y="22" width="876" height="476" rx="14" fill="#fdf6ec" stroke="#e5d8c5"/>
    <text x="40" y="64" fill="#827568" font-size="13" font-weight="800">Visual Brief</text>
    ${textRows(wrapText(brief.title, 46, 2), 40, 104, { size: 28, weight: 850, color: '#352f28', gap: 34 })}
    <rect x="706" y="48" width="150" height="34" rx="17" fill="${status.bg}" stroke="${status.line}"/>
    <text x="730" y="70" fill="${status.fg}" font-size="14" font-weight="850">${escapeXml(brief.status)}</text>
    ${textRows(wrapText(brief.goal, 74, 2), 40, 146, { size: 15, weight: 600, color: '#5f544b', gap: 21 })}
    ${cards}
    <text x="40" y="296" fill="#352f28" font-size="16" font-weight="850">Latest work trail</text>
    ${timeline}
    <text x="556" y="296" fill="#352f28" font-size="16" font-weight="850">Next action</text>
    ${nextActions}
    <text x="40" y="474" fill="#827568" font-size="12" font-weight="650">Generated ${escapeXml(brief.generatedAt)} · ${escapeXml(brief.wikiFile || 'wiki file pending')}</text>
  </svg>`;
}

function buildVisualBriefMarkdown(brief) {
  const cards = brief.cards.map((card) => `- ${card.label}: ${redactSensitiveText(card.value)}`).join('\n');
  const trail = brief.timeline.map((item) => `- ${item.label}: ${redactSensitiveText(item.value)}`).join('\n');
  const actions = brief.nextActions.map((item) => `- ${redactSensitiveText(item)}`).join('\n');
  return [
    '## Visual Brief',
    '',
    `- title: ${redactSensitiveText(brief.title)}`,
    `- status: ${redactSensitiveText(brief.status)}`,
    `- generated_at: ${brief.generatedAt}`,
    `- source_file: ${redactSensitiveText(brief.wikiFile || '')}`,
    '',
    '### Summary Cards',
    cards,
    '',
    '### Latest Work Trail',
    trail,
    '',
    '### Next Actions',
    actions,
  ].join('\n');
}

function buildVisualBrief({ run, task, generatedAt = new Date().toISOString() } = {}) {
  const target = run || task;
  if (!target) throw new Error('run or task is required');
  const kind = run ? 'run' : 'task';
  const title = trimText(target.name || target.title || target.goal || target.id || 'Hermes work', 96);
  const status = trimText(target.status || (kind === 'run' ? 'running' : 'Planned'), 28);
  const brief = {
    id: target.id || slugify(title, 'visual-brief'),
    slug: slugify(target.name || target.title || target.goal || target.id || 'visual-brief', 'visual-brief'),
    kind,
    title,
    goal: trimText(target.goal || target.title || 'No goal provided', 180),
    status,
    statusTone: statusTone(status),
    generatedAt,
    wikiFile: target.file || target.wikiDestination || target.wikiWriteBack || '',
    cards: buildCards(target, kind),
    timeline: buildTimeline(target),
    nextActions: buildNextActions(status),
  };
  brief.svg = renderVisualBriefSvg(brief);
  brief.markdown = buildVisualBriefMarkdown(brief);
  return brief;
}

module.exports = {
  buildVisualBrief,
  buildVisualBriefMarkdown,
  redactSensitiveText,
  renderVisualBriefSvg,
};
