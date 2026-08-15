'use strict';

const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const { assertWorkspaceScope } = require('./workspace-scope');

const BOOTSTRAP_ORIGINS = new Set(['calendar', 'mail', 'file']);
const MAX_EVIDENCE_ITEMS = 60;

function bounded(value, maximum = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function evidenceRecord({ id, origin, label, evidenceHandle, citation, content, occurredAt = null }) {
  const record = {
    id: bounded(id, 300),
    origin: bounded(origin, 40),
    label: bounded(label, 240),
    evidenceHandle: bounded(evidenceHandle, 500),
    citation: bounded(citation, 300),
    content: bounded(content),
    occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
  };
  if (!record.id || !BOOTSTRAP_ORIGINS.has(record.origin)) return null;
  if (!record.evidenceHandle || !record.citation || !record.content) return null;
  return record;
}

class SourceLibrary {
  constructor({ pool, unifiedCalendar = null, knowledge = null } = {}) {
    if (!pool) throw new Error('SourceLibrary requires pool');
    this.pool = pool;
    this.unifiedCalendar = unifiedCalendar;
    this.knowledge = knowledge;
  }

  async listBootstrapSources(scope) {
    assertWorkspaceScope(scope);
    const inventory = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const calendar = await client.query(
        `select o.id, o.title, o.starts_at, o.ends_at, o.timezone, s.id as source_id, s.label
         from calendar_occurrences o
         inner join calendar_sources s
           on s.workspace_id = o.workspace_id and s.id = o.source_id
         where o.workspace_id = $1
           and o.status not in ('cancelled', 'deleted')
           and s.provider = 'google'
           and s.source_kind = 'external_calendar'
           and s.status in ('connected', 'syncing')
         order by o.starts_at desc, o.id
         limit 25`,
        [valid.workspaceId],
      );
      const handles = await client.query(
        `select e.id, e.handle_token, e.citation_label, e.created_at
         from knowledge_evidence_handles e
         inner join knowledge_sources s
           on s.workspace_id = e.workspace_id and s.id = e.source_id
         where e.workspace_id = $1
           and e.status = 'active'
           and s.status in ('ready', 'active')
           and s.source_kind in ('cloud_indexed', 'private_local')
         order by e.created_at desc, e.id
         limit 25`,
        [valid.workspaceId],
      );
      return { calendar: calendar.rows, handles: handles.rows };
    });

    const sources = inventory.calendar.map((row) => evidenceRecord({
      id: `calendar:${row.source_id}:${row.id}`,
      origin: 'calendar',
      label: row.label || row.title || 'Google Calendar',
      evidenceHandle: `calendar-occurrence:${row.id}`,
      citation: `${row.label || 'Google Calendar'} · ${new Date(row.starts_at).toISOString()}`,
      content: `일정 제목: ${row.title || '(제목 없음)'}; 시작: ${new Date(row.starts_at).toISOString()}; 종료: ${new Date(row.ends_at).toISOString()}; 시간대: ${row.timezone || 'UTC'}`,
      occurredAt: row.starts_at,
    })).filter(Boolean);

    if (this.unifiedCalendar && typeof this.unifiedCalendar.listMailMessages === 'function') {
      const mail = await this.unifiedCalendar.listMailMessages(scope, { limit: 25 });
      const items = Array.isArray(mail && mail.items)
        ? mail.items
        : (Array.isArray(mail && mail.messages) ? mail.messages : []);
      if (mail && mail.connector === 'connected') {
        for (const item of items) {
          const messageId = bounded(item && item.id, 300);
          const content = [
            `보낸 사람: ${bounded(item && item.from, 240)}`,
            `제목: ${bounded(item && item.subject, 300)}`,
            `내용 미리보기: ${bounded(item && (item.snippet || item.preview), 700)}`,
          ].join('; ');
          const record = evidenceRecord({
            id: `mail:${messageId}`,
            origin: 'mail',
            label: item && item.subject || 'Google Mail',
            evidenceHandle: `gmail-message:${messageId}`,
            citation: `Google Mail · ${bounded(item && item.subject, 220) || messageId}`,
            content,
            occurredAt: item && (item.receivedAt || item.createdAt),
          });
          if (messageId && record) sources.push(record);
        }
      }
    }

    if (this.knowledge && typeof this.knowledge.resolveEvidence === 'function') {
      for (const handle of inventory.handles) {
        try {
          const resolved = await this.knowledge.resolveEvidence(scope, handle.handle_token);
          const record = evidenceRecord({
            id: `file:${handle.id}`,
            origin: 'file',
            label: resolved.title || handle.citation_label || 'File',
            evidenceHandle: resolved.handle || handle.handle_token,
            citation: resolved.title || handle.citation_label || 'File evidence',
            content: resolved.excerpt,
            occurredAt: handle.created_at,
          });
          if (record) sources.push(record);
        } catch {
          // A revoked or unreadable handle is not bootstrap evidence.
        }
      }
    }

    return sources.filter(Boolean).slice(0, MAX_EVIDENCE_ITEMS);
  }
}

module.exports = { BOOTSTRAP_ORIGINS, MAX_EVIDENCE_ITEMS, SourceLibrary, evidenceRecord };
