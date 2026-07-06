function compact(value) {
  return String(value || '').trim();
}

function taskLine(task = {}) {
  const status = compact(task.status) || 'Planned';
  const owner = compact(task.owner) || 'Task';
  const due = compact(task.due || task.date) || 'Unscheduled';
  const agent = compact(task.agent) || 'Yunseo';
  const project = compact(task.project);
  const tags = Array.isArray(task.tags) ? task.tags.map((tag) => `#${String(tag).replace(/^#/, '')}`).join(' ') : compact(task.tags);
  const meta = [
    owner,
    status,
    due,
    agent,
    project ? `@${project}` : '',
    tags,
  ].filter(Boolean).join(' · ');
  return `- [${status}] ${compact(task.title) || 'Untitled task'}\n  ${meta}`;
}

function buildTaskShareDraft({ tasks = [], channel = 'post', now = new Date() } = {}) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const date = now instanceof Date ? now.toISOString().slice(0, 10) : String(now || '').slice(0, 10);
  const subject = `Hermes task digest (${safeTasks.length}) · ${date}`;
  const markdown = [
    `# ${subject}`,
    '',
    ...safeTasks.map(taskLine),
  ].join('\n');
  const postText = [
    subject,
    '',
    ...safeTasks.map((task) => taskLine(task).replace(/\n  /g, ' — ')),
  ].join('\n');
  const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(markdown)}`;
  return {
    channel,
    count: safeTasks.length,
    subject,
    markdown,
    postText,
    mailtoUrl,
  };
}

module.exports = {
  buildTaskShareDraft,
};
