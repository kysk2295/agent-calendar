const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveHermesAgent } = require('./agent-registry');
const { AgentWorkContractError } = require('./agent-work-contract');
const { deliveryFromEvent, deliveryMetadata } = require('./agent-work-delivery');
const {
  createOfficialProfileAgent,
  isOfficialProfileName,
  resolveOfficialProfileName,
  resolveProductAgentName,
  resolveRequestedOfficialProfile,
} = require('./official-profiles');
const { dateStamp, slugify } = require('./wiki');

function createId(prefix, clock) {
  const stamp = clock().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `${prefix}-${stamp}-${suffix}`;
}

function defaultClock() {
  return new Date();
}

function isExecutableTickTickTask(text) {
  return /(^|\s)\/hermes\b/i.test(text) || /(^|\s)#(hermes|agent|auto)\b/i.test(text);
}

function isCalendarTaskRecord(task = {}) {
  const kind = String(task.kind || task.type || task.recordType || '').trim();
  const source = String(task.source || '').trim();
  return kind === 'calendar-event'
    || kind === 'event'
    || source === 'calendar'
    || source === 'calendar-event'
    || source === 'ticktick-calendar'
    || source === 'external-calendar';
}

function sortCalendarEvents(events = []) {
  return [...events].sort((a, b) => (
    String(a.date || a.startDate || '').localeCompare(String(b.date || b.startDate || ''))
    || String(a.time || a.t || '').localeCompare(String(b.time || b.t || ''))
    || String(a.title || '').localeCompare(String(b.title || ''))
  ));
}

function cleanTickTickTitle(text) {
  return text
    .replace(/^\s*\/hermes\b/i, '')
    .replace(/#\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePriority(value, title = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (['high', 'medium', 'low', 'none'].includes(raw)) return raw;
  if (/!1|높음|긴급|high/i.test(title)) return 'high';
  if (/!2|보통|medium/i.test(title)) return 'medium';
  if (/!3|낮음|low/i.test(title)) return 'low';
  return 'none';
}

function tickTickDateParts(task = {}) {
  const raw = String(task.startDate || task.due || task.date || task.dueDate || task.completedTime || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):?(\d{2})?)?/);
  if (!match) return { date: '', time: '' };
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: match[4] ? `${match[4]}:${match[5] || '00'}` : '',
  };
}

function isTickTickDone(task = {}) {
  return Boolean(task.completedTime) || /^done|completed|2$/i.test(String(task.status || ''));
}

function tickTickTaskTitle(task = {}) {
  return String(task.title || task.original || 'TickTick task').replace(/^\s*\/hermes\b/i, '').replace(/\s+/g, ' ').trim() || 'TickTick task';
}

function tickTickTaskToNativeInput(task = {}) {
  const dateParts = tickTickDateParts(task);
  const done = isTickTickDone(task);
  const executable = task.executable !== false;
  return {
    title: tickTickTaskTitle(task),
    owner: executable ? 'Agent' : 'Me',
    status: done ? 'Done' : 'Not Started',
    date: dateParts.date,
    time: dateParts.time,
    due: task.due || task.date || task.startDate || task.dueDate || '',
    agent: executable ? 'default' : 'Yunseo',
    model: 'Codex',
    priority: task.priority || 'none',
    project: task.project || task.projectName || 'TickTick Import',
    notes: [task.content, task.original && task.original !== task.title ? task.original : ''].filter(Boolean).join('\n\n'),
    tags: extractTags(task.title || task.original || '', task.tags || []),
    source: 'hermes-task-db',
    sourceId: String(task.id || task.taskId || ''),
    ticktickId: String(task.id || task.taskId || ''),
    ticktickProjectId: String(task.projectId || task.ticktickProjectId || ''),
    ticktickSyncStatus: 'imported-once',
    ticktickSyncedAt: task.importedAt || '',
    completedAt: done ? String(task.completedTime || '') : '',
  };
}

function extractTags(title = '', tags = []) {
  const explicit = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const fromTitle = String(title || '').match(/#[\w가-힣-]+/g) || [];
  return [...explicit, ...fromTitle]
    .map((tag) => String(tag || '').replace(/^#/, '').trim())
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index);
}

function extractProject(title = '', project = '') {
  if (project) return String(project).replace(/^@/, '').trim();
  const match = String(title || '').match(/@([\w가-힣-]+)/);
  return match ? match[1] : '';
}

function normalizeChecklist(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    if (item && typeof item === 'object') {
      return {
        id: String(item.id || `check-${index + 1}`),
        text: String(item.text || item.title || '').trim(),
        done: Boolean(item.done || item.completed),
      };
    }
    return {
      id: `check-${index + 1}`,
      text: String(item || '').trim(),
      done: false,
    };
  }).filter((item) => item.text);
}

function normalizeStringArray(items = []) {
  if (!Array.isArray(items)) return String(items || '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.map((item) => String(item || '').trim()).filter(Boolean);
}

const WORKBOARD_BLOCK_KINDS = new Set(['paragraph', 'heading', 'todo', 'bullet', 'divider', 'callout']);

function normalizeWorkboardBlock(block = {}, index = 0, clock = defaultClock) {
  const kind = WORKBOARD_BLOCK_KINDS.has(String(block.kind || '')) ? String(block.kind) : 'paragraph';
  const now = clock().toISOString();
  return {
    id: String(block.id || createId('wb', clock)),
    kind,
    text: String(block.text || ''),
    ...(kind === 'todo' ? { checked: Boolean(block.checked) } : {}),
    createdAt: String(block.createdAt || now),
    updatedAt: String(block.updatedAt || now),
    order: Number.isFinite(Number(block.order)) ? Number(block.order) : index,
  };
}

function normalizeWorkboardPage(page = {}, clock = defaultClock) {
  const now = clock().toISOString();
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  return {
    id: String(page.id || createId('wp', clock)),
    title: String(page.title || '제목 없음').trim() || '제목 없음',
    icon: String(page.icon || '▦'),
    tag: String(page.tag || ''),
    blocks: blocks.map((block, index) => normalizeWorkboardBlock(block, index, clock)),
    createdAt: String(page.createdAt || now),
    updatedAt: String(page.updatedAt || now),
  };
}

function cleanMailMessageId(value = '') {
  const text = String(value || '').trim().replace(/^<|>$/g, '');
  return text.replace(/[\s<>]+/g, '') || crypto.createHash('sha1').update(String(value || Date.now())).digest('hex').slice(0, 16);
}

function mailProviderLabel(provider = '') {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'gmail' || normalized === 'google') return 'Gmail';
  if (normalized === 'naver') return 'Naver Mail';
  return 'Mail';
}

function normalizeMailProvider(provider = '') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'google') return 'gmail';
  if (normalized === 'navermail') return 'naver';
  return normalized || 'mail';
}

function normalizeMailMessage(message = {}, clock = defaultClock) {
  const provider = normalizeMailProvider(message.provider);
  const accountId = String(message.accountId || message.email || message.username || provider).trim();
  const messageId = cleanMailMessageId(message.messageId || `${accountId}-${message.receivedAt || clock().toISOString()}-${message.subject || ''}`);
  const subject = String(message.subject || '(no subject)').trim();
  const text = String(message.text || message.body || message.preview || '').trim();
  const receivedAt = message.receivedAt ? new Date(message.receivedAt).toISOString() : clock().toISOString();
  return {
    id: `mail:${accountId}:${messageId}`,
    accountId,
    provider,
    from: String(message.from || '').trim(),
    subject,
    text,
    receivedAt,
    messageId,
    importedAt: clock().toISOString(),
  };
}

const BENCHMARK_FIXTURE_TEXT = 'Retrieval augmented generation benchmark evidence. Hypothesis: better retrieval quality improves answer accuracy and daily experiment loops.';
const PLAYWRIGHT_UPLOAD_TEXT = 'Playwright evidence upload check\nsource: web direct upload';
const PROTECTED_AGENT_IDS = new Set(['default']);

function agentIdentityKeys(agent = {}) {
  return [
    agent.id,
    agent.displayName,
    agent.name,
    agent.agentIdentity?.id,
    agent.agentIdentity?.displayName,
    agent.runtimeBinding?.agentKey,
    agent.profile?.name,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function isProtectedAgentId(value = '') {
  return PROTECTED_AGENT_IDS.has(String(value || '').trim().toLowerCase());
}

function isHermesProfileAgent(agent = {}) {
  return agent.agentSource === 'hermes-cli'
    || agent.agentIdentity?.source === 'hermes-cli'
    || agent.agentIdentity?.kind === 'mac-mini-hermes-profile'
    || agent.executionBackend?.id === 'hermes-cli'
    || agent.runtimeBinding?.executionBackendId === 'hermes-cli';
}

function formatByteSize(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function documentTypeLabel(mimeType = '', filename = '') {
  const type = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'PDF';
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/i.test(name)) return 'Image';
  if (type.includes('markdown') || name.endsWith('.md')) return 'Markdown';
  if (type.startsWith('text/') || /\.(txt|log|csv|json)$/i.test(name)) return 'Text';
  if (type.startsWith('audio/')) return 'Audio';
  if (type.startsWith('video/')) return 'Video';
  return 'File';
}

function ocrLabel(status = '') {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'completed') return 'OCR 완료';
  if (normalized === 'extracted') return '텍스트 추출';
  if (normalized === 'failed') return '실패';
  if (normalized === 'skipped') return '—';
  return '대기';
}

function compactDateLabel(isoDate = '') {
  const date = isoDate ? new Date(isoDate) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function normalizeDocumentStatus(status = '', content = '', document = {}) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'completed') {
    const hasOcrEvidence = Boolean(document.ocrEngine || document.ocrProvider || document.ocrCompletedAt || document.extractionMethod === 'ocr');
    return hasOcrEvidence ? 'completed' : (String(content || '').trim() ? 'extracted' : 'pending');
  }
  if (['extracted', 'failed', 'pending', 'skipped'].includes(normalized)) return normalized;
  return String(content || '').trim() ? 'extracted' : 'pending';
}

function hasDocumentTag(document = {}, tag = '') {
  const wanted = String(tag || '').toLowerCase();
  return (document.tags || []).some((item) => String(item || '').toLowerCase() === wanted);
}

function detectDocumentProvenance(document = {}) {
  const explicit = String(document.provenance || '').trim();
  if (explicit) return explicit;
  const filename = String(document.filename || document.name || document.title || '').toLowerCase();
  const body = [
    document.title,
    document.filename,
    document.name,
    document.source,
    document.sourceLabel,
    document.extractedText,
    document.extract,
    ...(document.tags || []),
  ].map((value) => String(value || '').toLowerCase()).join('\n');

  if (
    hasDocumentTag(document, 'playwright')
    || body.includes(PLAYWRIGHT_UPLOAD_TEXT.toLowerCase())
    || (filename.includes('benchmark-evidence-paper') && body.includes(BENCHMARK_FIXTURE_TEXT.toLowerCase()))
    || filename.startsWith('hermes-evidence-playwright')
  ) {
    return 'test-fixture';
  }
  if (String(document.source || '').toLowerCase() === 'seed' || hasDocumentTag(document, 'demo')) return 'seed-demo';
  if (String(document.source || '').toLowerCase() === 'telegram' || document.telegramFileId || document.telegramFileUniqueId) return 'telegram-original';
  if (String(document.source || '').toLowerCase() === 'web' || String(document.sourceLabel || '').toLowerCase() === 'web upload') return 'web-upload';
  return 'document-ingest';
}

function documentProvenanceLabel(provenance = '') {
  return ({
    'test-fixture': '테스트 fixture',
    'seed-demo': '시드 데모',
    'telegram-original': 'Telegram 원본',
    'web-upload': '실제 업로드',
    'document-ingest': '문서 기록',
  })[provenance] || '문서 기록';
}

function normalizeDocumentRecord(document = {}) {
  const title = String(document.title || document.filename || document.name || 'Untitled document').trim();
  const filename = String(document.filename || document.name || title).trim();
  const mimeType = String(document.mimeType || document.type || 'text/plain').trim();
  const content = String(document.extractedText || document.content || document.text || document.extract || '').trim();
  const sizeValue = Number(document.size || Buffer.byteLength(content, 'utf8') || 0);
  const size = Number.isFinite(sizeValue) ? sizeValue : Buffer.byteLength(content, 'utf8');
  const ocrStatus = normalizeDocumentStatus(document.ocrStatus, content, document);
  const source = String(document.source || 'web').trim();
  const sourceLabel = String(document.sourceLabel || (source === 'telegram' ? 'Telegram' : source === 'web' ? 'Web upload' : source)).trim();
  const id = document.id === undefined || document.id === null ? '' : String(document.id);
  const originalFilePath = String(document.originalFilePath || '').trim();
  const assetUrl = String(document.assetUrl || document.previewUrl || (id && originalFilePath ? `/api/documents/${encodeURIComponent(id)}/asset` : '')).trim();
  const provenance = detectDocumentProvenance({
    ...document,
    title,
    filename,
    name: filename,
    mimeType,
    extractedText: content,
    source,
    sourceLabel,
  });
  const evidenceVisible = !['test-fixture', 'seed-demo'].includes(provenance);
  return {
    ...document,
    title,
    name: filename,
    filename,
    mimeType,
    type: document.type || documentTypeLabel(mimeType, filename),
    size,
    sizeLabel: document.sizeLabel || formatByteSize(size),
    tags: extractTags('', document.tags || []),
    ocrStatus,
    ocr: ocrLabel(ocrStatus),
    extractedText: content,
    extract: document.extract || content,
    summary: document.summary || (content ? '업로드된 증거에서 텍스트를 추출했습니다.' : '파일 메타데이터를 기록했습니다. 원문 추출 또는 OCR 대기 중입니다.'),
    source,
    sourceLabel,
    originalFilePath,
    originalFileMimeType: document.originalFileMimeType || '',
    assetUrl,
    previewUrl: document.previewUrl || assetUrl,
    provenance,
    provenanceLabel: documentProvenanceLabel(provenance),
    evidenceVisible,
    isTestFixture: provenance === 'test-fixture',
  };
}

function normalizeToolType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'mcp') return 'MCP';
  if (raw === 'plugin') return 'Plugin';
  if (raw === 'script') return 'Script';
  return 'Skill';
}

function normalizeToolStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['disabled', 'draft', 'error'].includes(raw)) return raw;
  return 'enabled';
}

function normalizeToolRisk(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['low', 'medium', 'high'].includes(raw)) return raw;
  return 'medium';
}

function sanitizeWebhookUrl(value) {
  if (!value) return '';
  try {
    const webhookUrl = new URL(value);
    webhookUrl.searchParams.delete('access_token');
    return webhookUrl.toString();
  } catch {
    return String(value || '').replace(/([?&]access_token=)[^&]+/g, '$1redacted');
  }
}

function sanitizeTelegramStatusText(value) {
  return String(value || '')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b\d{6,12}:AA[A-Za-z0-9_-]{30,}/g, '[redacted-telegram-token]')
    .replace(/([?&]access_token=)[^&\s]+/gi, '$1redacted')
    .replace(/(?:token|secret|password)\s*[=:]\s*[^\s]+/gi, '[redacted]')
    .slice(0, 500);
}

function createDefaultState(now = new Date().toISOString()) {
  return {
    meta: {
      version: 1,
      createdAt: now,
      updatedAt: now,
      noApprovalMode: true,
    },
    tasks: [],
    agentMissions: [],
    agentSessions: [],
    agentSessionEvents: [],
    agentReports: [],
    ticktickTasks: [],
    events: [],
    externalCalendarEvents: [],
    sessions: [],
    agents: [],
    runs: [],
    documents: [],
    tools: [],
    chatMessages: [],
    mailMessages: [],
    workboardPages: [],
    commandInboxArchivedIds: [],
    commandInboxStarredIds: [],
    schedulerJobs: [],
    deletedAgentIds: [],
    daemon: {
      running: false,
      intervalMs: 60000,
      lastRun: null,
      lastError: null,
    },
    mailSyncStatus: null,
    remoteVerification: null,
    telegramWebhook: null,
    telegramChatCandidates: [],
    reflections: [],
    skillCandidates: [],
    reviewerItems: [],
    learningAgents: [],
    agentProfileRequests: [],
  };
}

class HermesStore {
  constructor({ dataDir, clock = defaultClock } = {}) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'work/hermes-os-data');
    this.clock = clock;
    this.statePath = path.join(this.dataDir, 'state.json');
    this.atomicState = null;
    this.atomicWriteRequested = false;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  getState() {
    return this.#load();
  }

  createDelegatedWork({ mission, conversation, message } = {}) {
    const state = this.#load({ persistDefault: false });
    const existingMission = state.agentMissions.find((item) => item.id === mission?.id);
    if (existingMission) {
      if (existingMission.requestFingerprint !== mission.requestFingerprint) {
        throw new AgentWorkContractError(
          'work_idempotency_conflict',
          'clientRequestId was already used for different work',
          409,
        );
      }
      if (
        existingMission.missionThreadId !== conversation.id
        || existingMission.workConversationId !== conversation.id
      ) {
        throw new AgentWorkContractError(
          'work_persistence_incomplete',
          'Delegated work points to a different Work Conversation',
          500,
        );
      }
      let existingConversation = state.agentSessions.find((item) => (
        item.id === existingMission.missionThreadId && item.missionId === existingMission.id
      ));
      let existingMessage = state.agentSessionEvents.find((item) => (
        item.id === message.id && item.sessionId === existingConversation?.id
      ));
      if (
        existingConversation
        && (
          existingConversation.type !== 'mission-thread'
          || existingConversation.title !== conversation.title
          || existingConversation.taskId !== ''
          || !['draft', 'planning', 'waiting_for_approval'].includes(existingConversation.status)
        )
      ) {
        throw new AgentWorkContractError(
          'work_persistence_incomplete',
          'Stored Work Conversation does not match the Delegated Work',
          500,
        );
      }
      if (
        existingMessage
        && (
          existingMessage.kind !== 'user_message'
          || existingMessage.text !== message.text
          || Number(existingMessage.sequence) !== 1
          || existingMessage.metadata?.clientMessageId !== message.metadata.clientMessageId
          || existingMessage.metadata?.applicationMode !== 'mission_context'
          || existingMessage.metadata?.acceptedAt !== existingMessage.createdAt
        )
      ) {
        throw new AgentWorkContractError(
          'work_persistence_incomplete',
          'Stored initial message does not match the Delegated Work',
          500,
        );
      }
      let repaired = false;
      if (!existingConversation) {
        if (state.agentSessions.some((item) => item.id === conversation.id)) {
          throw new AgentWorkContractError(
            'work_persistence_incomplete',
            'Work Conversation identifier belongs to different work',
            500,
          );
        }
        existingConversation = { ...conversation };
        state.agentSessions.unshift(existingConversation);
        repaired = true;
      }
      if (!existingMessage) {
        if (state.agentSessionEvents.some((item) => item.id === message.id)) {
          throw new AgentWorkContractError(
            'work_persistence_incomplete',
            'Initial message identifier belongs to a different conversation',
            500,
          );
        }
        existingMessage = { ...message };
        state.agentSessionEvents.push(existingMessage);
        repaired = true;
      }
      if (repaired) this.#touchAndSave(state);
      return {
        mission: existingMission,
        conversation: existingConversation,
        message: existingMessage,
        idempotentReplay: true,
      };
    }
    if (
      state.agentSessions.some((item) => item.id === conversation?.id)
      || state.agentSessionEvents.some((item) => item.id === message?.id)
    ) {
      throw new AgentWorkContractError(
        'work_idempotency_conflict',
        'Deterministic work identifiers already exist',
        409,
      );
    }
    const now = this.clock().toISOString();
    const storedMission = {
      ...mission,
      status: String(mission.status || 'draft'),
      createdAt: String(mission.createdAt || now),
      updatedAt: now,
    };
    const storedConversation = {
      ...conversation,
      pendingInstructions: normalizeStringArray(conversation.pendingInstructions),
      createdAt: String(conversation.createdAt || now),
      updatedAt: now,
      lastEventAt: String(message.createdAt || now),
    };
    const storedMessage = {
      ...message,
      sequence: 1,
      createdAt: String(message.createdAt || now),
    };
    state.agentMissions.unshift(storedMission);
    state.agentSessions.unshift(storedConversation);
    state.agentSessionEvents.push(storedMessage);
    this.#touchAndSave(state);
    return {
      mission: storedMission,
      conversation: storedConversation,
      message: storedMessage,
      idempotentReplay: false,
    };
  }

  addDelegatedWorkMessage(input = {}) {
    const state = this.#load();
    const mission = state.agentMissions.find((item) => item.id === input.missionId);
    if (!mission) {
      throw new AgentWorkContractError('work_not_found', 'Delegated work was not found', 404);
    }
    const conversation = state.agentSessions.find((item) => (
      item.id === mission.missionThreadId && item.type === 'mission-thread'
    ));
    if (!conversation) {
      throw new AgentWorkContractError(
        'work_persistence_incomplete',
        'Work Conversation was not found',
        500,
      );
    }
    const existing = state.agentSessionEvents.find((event) => (
      event.sessionId === conversation.id
      && event.metadata?.clientMessageId === input.clientMessageId
    ));
    if (existing) {
      if (existing.text !== input.text) {
        throw new AgentWorkContractError(
          'work_message_idempotency_conflict',
          'clientMessageId was already used for different text',
          409,
        );
      }
      return {
        message: existing,
        delivery: deliveryFromEvent(existing),
        idempotentReplay: true,
      };
    }
    const authoritative = input.authoritativeEvent;
    if (
      authoritative
      && (
        authoritative.id !== input.eventId
        || authoritative.sessionId !== conversation.id
        || authoritative.kind !== 'user_message'
        || authoritative.text !== input.text
        || authoritative.metadata?.clientMessageId !== input.clientMessageId
      )
    ) {
      throw new AgentWorkContractError(
        'work_persistence_incomplete',
        'Authoritative Work Conversation message does not match the request',
        500,
      );
    }
    const sequence = state.agentSessionEvents
      .filter((event) => event.sessionId === conversation.id)
      .reduce((maximum, event) => Math.max(maximum, Number(event.sequence) || 0), 0) + 1;
    const message = authoritative ? { ...authoritative } : {
      id: input.eventId,
      sessionId: conversation.id,
      sequence,
      kind: 'user_message',
      text: input.text,
      createdAt: input.acceptedAt,
      metadata: {
        clientMessageId: input.clientMessageId,
        ...deliveryMetadata(input.delivery || {
          status: 'accepted',
          applicationMode: 'mission_context',
        }, input.acceptedAt),
      },
    };
    state.agentSessionEvents.push(message);
    conversation.updatedAt = this.clock().toISOString();
    conversation.lastEventAt = message.createdAt;
    this.#touchAndSave(state);
    return {
      message,
      delivery: deliveryFromEvent(message),
      idempotentReplay: false,
    };
  }

  applyDelegatedWorkCommand(input = {}, apply) {
    if (typeof apply !== 'function') throw new Error('Agent Work command application is required');
    return this.#runAtomic(() => {
      const stored = HermesStore.prototype.addDelegatedWorkMessage.call(this, input);
      if (stored.idempotentReplay) return stored;
      return apply(stored);
    });
  }

  getDelegatedWorkMessage(missionId, clientMessageId) {
    const state = this.#load();
    const mission = state.agentMissions.find((item) => item.id === missionId);
    const conversation = state.agentSessions.find((item) => (
      item.id === mission?.missionThreadId && item.type === 'mission-thread'
    ));
    if (!conversation) return null;
    return state.agentSessionEvents.find((event) => (
      event.sessionId === conversation.id
      && event.metadata?.clientMessageId === clientMessageId
    )) || null;
  }

  createRevisionCycle(input = {}) {
    const messageInput = input.message || {};
    const existing = this.getDelegatedWorkMessage(messageInput.missionId, messageInput.clientMessageId);
    if (existing) {
      if (existing.text !== messageInput.text) {
        throw new AgentWorkContractError(
          'work_message_idempotency_conflict',
          'clientMessageId was already used for different text',
          409,
        );
      }
      return {
        message: existing,
        delivery: deliveryFromEvent(existing),
        idempotentReplay: true,
      };
    }
    const state = this.#load();
    const mission = state.agentMissions.find((item) => item.id === messageInput.missionId);
    if (!mission) {
      throw new AgentWorkContractError('work_not_found', 'Delegated work was not found', 404);
    }
    if (mission.pendingRevisionId) {
      throw new AgentWorkContractError(
        'revision_already_pending',
        'Complete or retry the pending revision before starting another',
        409,
      );
    }
    const report = state.agentReports.find((item) => (
      item.id === input.baseReportId
      && item.missionId === mission.id
      && item.status === 'ready'
    ));
    const baseTask = state.tasks.find((item) => (
      item.id === input.baseTaskId
      && item.missionId === mission.id
      && item.status === 'completed'
    ));
    if (
      !report
      || !baseTask
      || mission.currentResultReportId !== report.id
      || report.taskId !== baseTask.id
    ) {
      throw new AgentWorkContractError(
        'revision_result_required',
        'A valid current result is required before requesting a revision',
        409,
      );
    }
    if (
      state.tasks.some((task) => task.id === input.task?.id)
      || state.agentSessions.some((session) => session.id === input.session?.id)
    ) {
      throw new AgentWorkContractError(
        'revision_already_pending',
        'Revision records already exist',
        409,
      );
    }
    return this.#runAtomic(() => {
      const stored = this.addDelegatedWorkMessage({
        ...messageInput,
        delivery: input.delivery,
      });
      const task = this.createTask(input.task);
      const session = this.createAgentSession({ ...input.session, taskId: task.id });
      const events = (input.events || []).map((event) => (
        this.appendAgentSessionEvent(session.id, event)
      ));
      const updatedMission = this.updateAgentMission(mission.id, input.missionPatch);
      return {
        ...stored,
        mission: updatedMission,
        task,
        session,
        events,
        revisionId: task.revisionId,
        revisionNumber: task.revisionNumber,
      };
    });
  }

  completeRevisionCycle({ missionId, task, report, event } = {}) {
    const state = this.#load();
    const mission = state.agentMissions.find((item) => item.id === missionId);
    const previous = state.agentReports.find((item) => item.id === task?.revisesReportId);
    const existingCurrent = state.agentReports.find((item) => item.id === report?.id);
    if (
      !mission
      || !previous
      || !report?.id
      || mission.pendingRevisionId !== task?.revisionId
      || mission.currentResultReportId !== previous.id
      || report.taskId !== task?.id
      || (existingCurrent && existingCurrent.taskId !== task?.id)
    ) {
      throw new AgentWorkContractError(
        'revision_completion_invalid',
        'Revision completion records do not match the pending revision',
        409,
      );
    }
    return this.#runAtomic(() => {
      const current = existingCurrent || this.createAgentReport(report);
      const previousReport = this.updateAgentReport(previous.id, { supersededByReportId: current.id });
      const updatedReport = this.updateAgentReport(current.id, { supersedesReportId: previous.id });
      const updatedMission = this.updateAgentMission(mission.id, {
        pendingRevisionId: '',
        currentResultReportId: current.id,
      });
      const completionEvent = this.appendAgentSessionEvent(task.sessionId, event);
      return {
        mission: updatedMission,
        report: updatedReport,
        previousReport,
        event: completionEvent,
      };
    });
  }

  createAgentMission(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const id = String(input.id || createId('mission', this.clock));
    if (state.agentMissions.some((mission) => mission.id === id)) {
      throw new Error(`Agent mission already exists: ${id}`);
    }
    const mission = {
      ...input,
      id,
      status: String(input.status || 'draft'),
      createdAt: String(input.createdAt || now),
      updatedAt: now,
    };
    state.agentMissions.unshift(mission);
    this.#touchAndSave(state);
    return mission;
  }

  updateAgentMission(missionId, patch = {}) {
    const state = this.#load();
    const index = state.agentMissions.findIndex((mission) => mission.id === missionId);
    if (index < 0) return null;
    const mission = {
      ...state.agentMissions[index],
      ...patch,
      id: state.agentMissions[index].id,
      createdAt: state.agentMissions[index].createdAt,
      updatedAt: this.clock().toISOString(),
    };
    state.agentMissions[index] = mission;
    this.#touchAndSave(state);
    return mission;
  }

  getAgentMissions() {
    return this.#load().agentMissions;
  }

  createAgentSession(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const missionId = String(input.missionId || '');
    const taskId = String(input.taskId || '');
    if (!state.agentMissions.some((mission) => mission.id === missionId)) {
      throw new Error(`Agent mission not found: ${missionId || 'missing'}`);
    }
    const id = String(input.id || createId('session', this.clock));
    if (state.agentSessions.some((session) => session.id === id)) {
      throw new Error(`Agent session already exists: ${id}`);
    }
    const session = {
      ...input,
      id,
      missionId,
      taskId,
      status: String(input.status || 'proposed'),
      pendingInstructions: normalizeStringArray(input.pendingInstructions),
      createdAt: String(input.createdAt || now),
      updatedAt: now,
    };
    state.agentSessions.unshift(session);
    if (taskId) {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Agent task not found: ${taskId}`);
      task.missionId = missionId;
      task.sessionId = id;
      task.updatedAt = now;
    }
    this.#touchAndSave(state);
    return session;
  }

  updateAgentSession(sessionId, patch = {}) {
    const state = this.#load();
    const index = state.agentSessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return null;
    const session = {
      ...state.agentSessions[index],
      ...patch,
      id: state.agentSessions[index].id,
      missionId: state.agentSessions[index].missionId,
      taskId: state.agentSessions[index].taskId,
      pendingInstructions: Object.prototype.hasOwnProperty.call(patch, 'pendingInstructions')
        ? normalizeStringArray(patch.pendingInstructions)
        : state.agentSessions[index].pendingInstructions,
      createdAt: state.agentSessions[index].createdAt,
      updatedAt: this.clock().toISOString(),
    };
    state.agentSessions[index] = session;
    this.#touchAndSave(state);
    return session;
  }

  getAgentSession(sessionId) {
    const state = this.#load();
    const session = state.agentSessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const events = state.agentSessionEvents
      .filter((event) => event.sessionId === sessionId)
      .sort((left, right) => left.sequence - right.sequence);
    return { ...session, events };
  }

  appendAgentSessionEvent(sessionId, input = {}) {
    const state = this.#load();
    const session = state.agentSessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`Agent session not found: ${sessionId}`);
    const now = this.clock().toISOString();
    const sequence = state.agentSessionEvents
      .filter((event) => event.sessionId === sessionId)
      .reduce((maximum, event) => Math.max(maximum, Number(event.sequence) || 0), 0) + 1;
    const event = {
      ...input,
      id: String(input.id || createId('session-event', this.clock)),
      sessionId,
      sequence,
      kind: String(input.kind || 'progress'),
      text: String(input.text || ''),
      createdAt: String(input.createdAt || now),
    };
    state.agentSessionEvents.push(event);
    session.updatedAt = now;
    session.lastEventAt = event.createdAt;
    this.#touchAndSave(state);
    return event;
  }

  updateAgentSessionEvent(eventId, patch = {}) {
    const state = this.#load();
    const index = state.agentSessionEvents.findIndex((event) => event.id === eventId);
    if (index < 0) return null;
    const event = {
      ...state.agentSessionEvents[index],
      ...patch,
      id: state.agentSessionEvents[index].id,
      sessionId: state.agentSessionEvents[index].sessionId,
      sequence: state.agentSessionEvents[index].sequence,
      createdAt: state.agentSessionEvents[index].createdAt,
    };
    state.agentSessionEvents[index] = event;
    this.#touchAndSave(state);
    return event;
  }

  createAgentReport(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const missionId = String(input.missionId || '');
    if (!state.agentMissions.some((mission) => mission.id === missionId)) {
      throw new Error(`Agent mission not found: ${missionId || 'missing'}`);
    }
    const id = String(input.id || createId('report', this.clock));
    if (state.agentReports.some((report) => report.id === id)) {
      throw new Error(`Agent report already exists: ${id}`);
    }
    const report = {
      ...input,
      id,
      missionId,
      sessionId: String(input.sessionId || ''),
      status: String(input.status || 'ready'),
      createdAt: String(input.createdAt || now),
      updatedAt: now,
    };
    state.agentReports.unshift(report);
    this.#touchAndSave(state);
    return report;
  }

  updateAgentReport(reportId, patch = {}) {
    const state = this.#load();
    const index = state.agentReports.findIndex((report) => report.id === reportId);
    if (index < 0) return null;
    const report = {
      ...state.agentReports[index],
      ...patch,
      id: state.agentReports[index].id,
      missionId: state.agentReports[index].missionId,
      createdAt: state.agentReports[index].createdAt,
      updatedAt: this.clock().toISOString(),
    };
    state.agentReports[index] = report;
    this.#touchAndSave(state);
    return report;
  }

  getAgentReports() {
    return this.#load().agentReports;
  }

  createAgent(input) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const displayName = input.displayName || input.name || 'New Agent';
    const autonomyMode = input.autonomyMode || (input.noApproval === false ? 'approval-required' : 'no-approval');
    const id = createId('agent', this.clock);
    const agent = {
      id,
      displayName,
      name: displayName,
      persona: input.persona || '',
      role: input.role || 'general Hermes worker',
      engine: 'ad-hoc',
      model: input.model || 'Codex',
      agentSource: 'ad-hoc',
      agentIdentity: {
        id,
        displayName,
        source: 'ad-hoc',
        resident: false,
        kind: 'ad-hoc-agent',
      },
      autonomyMode,
      noApproval: autonomyMode !== 'approval-required',
      tools: normalizeStringArray(input.tools || ['shell', 'browser', 'LLM-Wiki']),
      stopConditions: normalizeStringArray(input.stopConditions || ['external account auth required', 'unsafe destructive action', 'cost or time budget exceeded']),
      successRubric: normalizeStringArray(input.successRubric || input.rubric || ['result is written to LLM-Wiki', 'verification evidence is recorded']),
      defaultWikiDestination: input.defaultWikiDestination || input.wikiDestination || '5_conversation/agent-runs',
      availability: input.availability || 'on demand',
      enabled: input.enabled !== false,
      status: input.enabled === false ? 'Idle' : 'Active',
      progress: 0,
      createdAt: now,
    };
    state.agents.push(agent);
    this.#touchAndSave(state);
    return agent;
  }

  updateAgent(agentId, patch = {}) {
    const wanted = String(agentId || '').trim();
    if (!wanted) return null;
    const state = this.#load();
    const now = this.clock().toISOString();
    const index = state.agents.findIndex((agent) => agentIdentityKeys(agent).includes(wanted));
    const current = index >= 0 ? state.agents[index] : {
      id: wanted,
      displayName: wanted,
      name: wanted,
      agentSource: 'hermes-cli',
      agentIdentity: {
        id: wanted,
        displayName: wanted,
        source: 'hermes-cli',
        resident: true,
        kind: 'mac-mini-hermes-profile',
      },
    };
    const dashboardSettings = {
      ...(current.dashboardSettings || {}),
      ...(patch.dashboardSettings || {}),
      ...(patch.displayName !== undefined ? { displayName: String(patch.displayName || '').trim() } : {}),
      ...(patch.persona !== undefined ? { persona: String(patch.persona || '') } : {}),
      ...(patch.role !== undefined ? { role: String(patch.role || '') } : {}),
      ...(patch.model !== undefined ? { model: String(patch.model || '') } : {}),
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    };
    const next = {
      ...current,
      displayName: dashboardSettings.displayName || current.displayName || wanted,
      name: dashboardSettings.displayName || current.name || current.displayName || wanted,
      persona: dashboardSettings.persona ?? current.persona ?? '',
      role: dashboardSettings.role ?? current.role ?? '',
      model: dashboardSettings.model || current.model || 'Recommended',
      enabled: dashboardSettings.enabled !== false,
      status: dashboardSettings.enabled === false ? 'Idle' : (current.status === 'Idle' ? 'Active' : (current.status || 'Active')),
      dashboardSettings,
      updatedAt: now,
    };
    if (index >= 0) state.agents[index] = next;
    else state.agents.push(next);
    this.#touchAndSave(state);
    return next;
  }

  createAgentProfileRequest(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const rawName = String(input.name || input.displayName || '').trim();
    const targetProfile = (rawName || 'profile-request')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'profile-request';
    const request = {
      id: createId('profile-request', this.clock),
      kind: 'hermes-cli-profile-request',
      status: 'pending',
      targetProfile,
      displayName: rawName || targetProfile,
      persona: String(input.persona || '').trim(),
      role: String(input.role || '').trim(),
      wikiDestination: String(input.wiki || input.wikiDestination || '2_wiki/projects').trim(),
      model: String(input.model || 'Recommended').trim(),
      command: `hermes profile create ${targetProfile}`,
      instructions: [
        'Run the command on the Mac mini after reviewing profile scope.',
        'Refresh Hermes OS agents after the profile appears in hermes profile list.',
      ],
      createdAt: now,
    };
    if (!Array.isArray(state.agentProfileRequests)) state.agentProfileRequests = [];
    state.agentProfileRequests.unshift(request);
    state.agentProfileRequests = state.agentProfileRequests.slice(0, 100);
    this.#touchAndSave(state);
    return request;
  }

  deleteAgent(agentId) {
    const wanted = String(agentId || '').trim();
    if (!wanted || isProtectedAgentId(wanted)) return null;
    const state = this.#load();
    const index = state.agents.findIndex((agent) => agentIdentityKeys(agent).includes(wanted));
    if (index >= 0 && isHermesProfileAgent(state.agents[index])) return null;
    const [agent] = index >= 0 ? state.agents.splice(index, 1) : [{ id: wanted, displayName: wanted, name: wanted }];
    const deletedIds = new Set([
      ...(Array.isArray(state.deletedAgentIds) ? state.deletedAgentIds : []),
      ...agentIdentityKeys(agent),
      wanted,
    ].map((value) => String(value || '').trim()).filter(Boolean));
    [...PROTECTED_AGENT_IDS].forEach((id) => deletedIds.delete(id));
    state.deletedAgentIds = [...deletedIds];
    this.#touchAndSave(state);
    return agent;
  }

  restoreAgent(agentId) {
    const wanted = String(agentId || '').trim();
    if (!wanted) return null;
    const state = this.#load();
    const normalized = wanted.toLowerCase();
    const before = Array.isArray(state.deletedAgentIds) ? state.deletedAgentIds : [];
    state.deletedAgentIds = before.filter((id) => String(id || '').trim().toLowerCase() !== normalized);
    this.#touchAndSave(state);
    return {
      id: wanted,
      restored: before.length !== state.deletedAgentIds.length,
      deletedAgentIds: state.deletedAgentIds,
    };
  }

  createRun(input) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const agent = this.#findAgent(state, input.agentId, input.agent, input.profileAgents);
    const goal = input.goal || 'Untitled Hermes run';
    const name = input.name || slugify(`${agent.displayName || agent.name}-${goal}`, 'agent-run');
    const date = dateStamp(now);
    const agentIdentity = agent.agentIdentity || {
      id: agent.id || agent.displayName || agent.name,
      displayName: agent.displayName || agent.name || agent.id || 'Hermes',
      source: agent.agentSource || 'ad-hoc',
      resident: false,
      kind: 'ad-hoc-agent',
    };
    const executionBackend = agent.executionBackend || null;
    const runtimeBinding = agent.runtimeBinding
      ? {
        ...agent.runtimeBinding,
        executionBackendId: agent.runtimeBinding.executionBackendId || executionBackend?.id || agent.runnerAdapter?.id || '',
        adapterId: agent.runtimeBinding.adapterId || executionBackend?.id || agent.runnerAdapter?.id || '',
      }
      : null;
    const runnerAdapter = executionBackend
      ? { ...executionBackend }
      : (agent.runnerAdapter?.id
        ? {
          id: agent.runnerAdapter.id,
          label: agent.runnerAdapter.label || agent.runnerAdapter.id,
          kind: agent.runnerAdapter.kind || 'tool-adapter',
          commandTemplate: agent.runnerAdapter.commandTemplate || '',
          model: agent.runnerAdapter.model || agent.model || input.model || 'Recommended',
        }
        : null);
    const run = {
      id: createId('run', this.clock),
      name,
      goal,
      agentId: agent.id,
      agent: agent.displayName || agent.name,
      agentSource: agentIdentity.source,
      agentIdentity,
      ...(executionBackend ? { executionBackend } : {}),
      ...(runtimeBinding ? { runtimeBinding } : {}),
      ...(runnerAdapter?.id ? { runnerAdapter } : {}),
      model: input.model || agent.model || 'Recommended',
      status: 'running',
      source: input.source || 'web',
      documentId: input.documentId ? String(input.documentId) : '',
      sourceDocument: input.sourceDocument || null,
      sourceDocumentPath: input.sourceDocumentPath || '',
      toolId: input.toolId ? String(input.toolId) : '',
      sourceTool: input.sourceTool || null,
      idempotencyKey: input.idempotencyKey ? String(input.idempotencyKey) : '',
      noApproval: false,
      autonomy: input.autonomy ? String(input.autonomy) : '',
      rubric: input.rubric ? String(input.rubric) : '',
      delegation: input.delegation && typeof input.delegation === 'object'
        ? {
          ready: Boolean(input.delegation.ready),
          blockers: normalizeStringArray(input.delegation.blockers),
          commandPreview: String(input.delegation.commandPreview || ''),
          gatewayState: String(input.delegation.gatewayState || ''),
        }
        : null,
      mission: input.mission || null,
      successCriteria: Array.isArray(input.successCriteria)
        ? input.successCriteria
        : normalizeStringArray(input.rubric ? [input.rubric] : []),
      stopConditions: Array.isArray(input.stopConditions) ? input.stopConditions : [],
      wikiWriteBack: input.wikiWriteBack || '',
      ...(input.usage && typeof input.usage === 'object' ? { usage: { ...input.usage } } : {}),
      ...(input.durationMs !== undefined ? { durationMs: Number(input.durationMs) || 0 } : {}),
      file: `5_conversation/agent-runs/${date}-${slugify(name, 'agent-run')}.md`,
      createdAt: now,
      logs: [
        'run created',
        `agent=${agent.displayName || agent.name}`,
        `model=${input.model || agent.model || 'Recommended'}`,
        input.mission ? `mission=${input.mission.id}` : '',
        'wiki write-back ready',
      ].filter(Boolean),
    };
    state.runs.unshift(run);
    state.sessions.unshift({ time: now.slice(11, 16), text: `${run.agent} · ${goal}`, state: 'Running' });
    this.#touchAndSave(state);
    return run;
  }

  saveRun(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const id = String(input.id || createId('run', this.clock));
    const existingIndex = state.runs.findIndex((item) => String(item.id) === id);
    const existing = existingIndex >= 0 ? state.runs[existingIndex] : {};
    const name = String(input.name || existing.name || input.goal || existing.goal || 'Hermes run');
    const run = {
      ...existing,
      ...input,
      id,
      name,
      goal: String(input.goal || existing.goal || name),
      agent: String(input.agent || existing.agent || 'Hermes'),
      model: String(input.model || existing.model || 'Codex'),
      status: String(input.status || existing.status || 'running'),
      source: String(input.source || existing.source || 'runtime'),
      file: String(input.file || input.wikiPath || existing.file || existing.wikiPath || ''),
      logs: Array.isArray(input.logs) ? input.logs : (Array.isArray(existing.logs) ? existing.logs : []),
      createdAt: String(existing.createdAt || input.createdAt || now),
      updatedAt: now,
    };
    if (existingIndex >= 0) {
      state.runs[existingIndex] = run;
    } else {
      state.runs.unshift(run);
      state.sessions.unshift({ time: now.slice(11, 16), text: `${run.agent} · ${run.goal}`, state: run.status });
    }
    this.#touchAndSave(state);
    return run;
  }

  createTask(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const owner = input.owner || 'Me';
    const status = input.status || (owner === 'Agent' ? 'Queued' : owner === 'Hybrid' ? 'Needs Review' : 'Planned');
    const date = input.date || '';
    const time = input.time || '';
    const task = {
      id: String(input.id || createId('task', this.clock)),
      title: input.title || 'Untitled task',
      owner,
      status,
      due: [date, time].filter(Boolean).join(' ') || input.due || 'Unscheduled',
      date,
      time,
      lane: input.lane || status,
      tag: input.tag || (owner === 'Agent' ? 'mint' : owner === 'Hybrid' ? 'amber' : 'neutral'),
      agent: owner === 'Me'
        ? (input.agent || 'Yunseo')
        : resolveRequestedOfficialProfile({ agentId: input.agentId, agent: input.agent }),
      model: input.model || 'Codex',
      executable: owner !== 'Me',
      successCriteria: Array.isArray(input.successCriteria) ? input.successCriteria.map(String) : [],
      wikiDestination: input.wikiDestination || '',
      priority: normalizePriority(input.priority, input.title),
      tags: extractTags(input.title, input.tags),
      project: extractProject(input.title, input.project),
      body: input.body ? String(input.body) : (input.notes ? String(input.notes) : ''),
      notes: input.notes ? String(input.notes) : '',
      checklist: normalizeChecklist(input.checklist || input.subtasks),
      reminders: normalizeStringArray(input.reminders),
      recurrence: input.recurrence ? String(input.recurrence) : '',
      runId: input.runId ? String(input.runId) : '',
      runFile: input.runFile ? String(input.runFile) : '',
      completedAt: input.completedAt || '',
      source: input.source || 'native',
      sourceId: input.sourceId ? String(input.sourceId) : '',
      missionId: input.missionId ? String(input.missionId) : '',
      sessionId: input.sessionId ? String(input.sessionId) : '',
      origin: input.origin ? String(input.origin) : '',
      createdByAgentId: input.createdByAgentId ? String(input.createdByAgentId) : '',
      reason: input.reason ? String(input.reason) : '',
      expectedOutput: input.expectedOutput ? String(input.expectedOutput) : '',
      scheduledAt: input.scheduledAt ? String(input.scheduledAt) : '',
      dueAt: input.dueAt ? String(input.dueAt) : '',
      estimatedMinutes: Number.isFinite(Number(input.estimatedMinutes)) ? Number(input.estimatedMinutes) : 0,
      actionClass: input.actionClass ? String(input.actionClass) : '',
      sourceRefs: normalizeStringArray(input.sourceRefs),
      executionEngine: input.executionEngine ? String(input.executionEngine) : '',
      deliverable: input.deliverable && typeof input.deliverable === 'object'
        ? { ...input.deliverable }
        : null,
      approvalMode: input.approvalMode ? String(input.approvalMode) : '',
      revisionId: input.revisionId ? String(input.revisionId) : '',
      revisionNumber: Number.isFinite(Number(input.revisionNumber)) ? Number(input.revisionNumber) : 0,
      revisesTaskId: input.revisesTaskId ? String(input.revisesTaskId) : '',
      revisesReportId: input.revisesReportId ? String(input.revisesReportId) : '',
      pauseRequestedAt: input.pauseRequestedAt ? String(input.pauseRequestedAt) : '',
      cancelRequestedAt: input.cancelRequestedAt ? String(input.cancelRequestedAt) : '',
      blockedReason: input.blockedReason ? String(input.blockedReason) : '',
      pauseMode: input.pauseMode ? String(input.pauseMode) : '',
      pendingInstructions: normalizeStringArray(input.pendingInstructions),
      attempt: Number.isFinite(Number(input.attempt)) ? Number(input.attempt) : 0,
      ticktickId: input.ticktickId ? String(input.ticktickId) : '',
      ticktickProjectId: input.ticktickProjectId ? String(input.ticktickProjectId) : '',
      ticktickSyncStatus: input.ticktickSyncStatus ? String(input.ticktickSyncStatus) : '',
      ticktickSyncedAt: input.ticktickSyncedAt ? String(input.ticktickSyncedAt) : '',
      ticktickSyncError: input.ticktickSyncError ? String(input.ticktickSyncError) : '',
      createdAt: input.createdAt ? String(input.createdAt) : now,
      updatedAt: now,
    };
    state.tasks.unshift(task);
    state.sessions.unshift({ time: now.slice(11, 16), text: `${task.owner} · ${task.title}`, state: task.status });
    this.#touchAndSave(state);
    return task;
  }

  searchTasks(query = '') {
    const state = this.#load();
    const needle = String(query || '').trim().toLowerCase();
    const filters = arguments[1] || {};
    return state.tasks.filter((task) => {
      if (isCalendarTaskRecord(task)) return false;
      if (filters.owner && task.owner !== filters.owner) return false;
      if (filters.status && task.status !== filters.status) return false;
      if (filters.view === 'completed' && !(task.status === 'Done' || task.completedAt)) return false;
      if (filters.view === 'today') {
        const date = filters.date || this.clock().toISOString().slice(0, 10);
        if (task.date !== date || task.status === 'Done' || task.completedAt) return false;
      }
      if (filters.view === 'upcoming') {
        const date = filters.date || this.clock().toISOString().slice(0, 10);
        if (!task.date || task.date < date || task.status === 'Done' || task.completedAt) return false;
      }
      if (!needle) return true;
      return [
        task.title,
        task.owner,
        task.status,
        task.due,
        task.date,
        task.time,
        task.agent,
        task.model,
        task.source,
        task.priority,
        task.project,
        ...(task.tags || []),
      ].some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }

  updateTask(taskId, patch = {}) {
    const state = this.#load();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    const allowed = [
      'title', 'owner', 'status', 'date', 'time', 'lane', 'tag', 'agent', 'model',
      'wikiDestination', 'project', 'body', 'notes', 'recurrence', 'runId', 'runFile',
      'missionId', 'sessionId', 'origin', 'createdByAgentId', 'reason', 'expectedOutput',
      'scheduledAt', 'dueAt', 'actionClass', 'approvalMode', 'pauseRequestedAt',
      'cancelRequestedAt', 'blockedReason', 'pauseMode', 'reportId', 'failureCode',
      'startedAt', 'finishedAt', 'retryScheduledAt',
      'revisionId', 'revisesTaskId', 'revisesReportId',
      'ticktickId', 'ticktickProjectId', 'ticktickSyncStatus', 'ticktickSyncedAt',
      'ticktickSyncError',
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        task[key] = String(patch[key] || '');
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'priority')) {
      task.priority = normalizePriority(patch.priority, task.title);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'tags')) {
      task.tags = extractTags('', patch.tags);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'checklist') || Object.prototype.hasOwnProperty.call(patch, 'subtasks')) {
      task.checklist = normalizeChecklist(patch.checklist || patch.subtasks);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'reminders')) {
      task.reminders = normalizeStringArray(patch.reminders);
    }
    if (Array.isArray(patch.successCriteria)) {
      task.successCriteria = patch.successCriteria.map(String);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sourceRefs')) {
      task.sourceRefs = normalizeStringArray(patch.sourceRefs);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'pendingInstructions')) {
      task.pendingInstructions = normalizeStringArray(patch.pendingInstructions);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'estimatedMinutes')) {
      task.estimatedMinutes = Number.isFinite(Number(patch.estimatedMinutes)) ? Number(patch.estimatedMinutes) : 0;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'attempt')) {
      task.attempt = Number.isFinite(Number(patch.attempt)) ? Number(patch.attempt) : 0;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'revisionNumber')) {
      task.revisionNumber = Number.isFinite(Number(patch.revisionNumber)) ? Number(patch.revisionNumber) : 0;
    }
    const taskIsCompleted = task.status === 'Done' || task.status === 'completed';
    if (taskIsCompleted && !task.completedAt) {
      task.completedAt = this.clock().toISOString();
    }
    if (!taskIsCompleted) {
      task.completedAt = '';
    }
    task.executable = task.owner !== 'Me';
    task.due = [task.date, task.time].filter(Boolean).join(' ') || patch.due || task.due || 'Unscheduled';
    task.updatedAt = this.clock().toISOString();
    this.#touchAndSave(state);
    return task;
  }

  claimAgentTask(taskId, patch = {}) {
    const task = this.getState().tasks.find((item) => item.id === taskId);
    if (!task || task.status !== 'scheduled') return null;
    return this.updateTask(taskId, { ...patch, status: 'running' });
  }

  deleteTask(taskId) {
    const state = this.#load();
    const index = state.tasks.findIndex((item) => item.id === taskId);
    if (index === -1) return null;
    const [task] = state.tasks.splice(index, 1);
    state.sessions.unshift({ time: this.clock().toISOString().slice(11, 16), text: `Deleted · ${task.title}`, state: 'Deleted' });
    this.#touchAndSave(state);
    return task;
  }

  createCalendarEvent(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const date = String(input.date || input.startDate || input.day || '').trim();
    const event = {
      ...input,
      id: String(input.id || createId('calendar', this.clock)),
      taskId: input.taskId ? String(input.taskId) : '',
      title: String(input.title || input.original || 'Untitled event'),
      original: String(input.original || input.title || ''),
      date,
      startDate: String(input.startDate || date),
      time: String(input.time || input.t || ''),
      endDate: String(input.endDate || input.dateEnd || input.dueDate || ''),
      endTime: String(input.endTime || input.tEnd || ''),
      allDay: Boolean(input.allDay),
      recurrence: String(input.recurrence || input.repeat || ''),
      repeat: String(input.repeat || input.recurrence || ''),
      repeatUntil: String(input.repeatUntil || ''),
      notes: String(input.notes || input.description || ''),
      owner: String(input.owner || input.o || 'Me'),
      status: String(input.status || input.st || 'Planned'),
      source: String(input.source || 'desktop-calendar-event'),
      kind: 'calendar-event',
      type: 'calendar-event',
      createdAt: now,
      updatedAt: now,
    };
    state.events.unshift(event);
    state.events = sortCalendarEvents(state.events).slice(0, 1500);
    this.#touchAndSave(state);
    return event;
  }

  searchCalendarEvents(query = '', filters = {}) {
    const state = this.#load();
    const needle = String(query || '').trim().toLowerCase();
    return (Array.isArray(state.events) ? state.events : []).filter((event) => {
      const date = String(event.date || event.startDate || '');
      if (filters.from && date && date < String(filters.from)) return false;
      if (filters.to && date && date > String(filters.to)) return false;
      if (!needle) return true;
      return [event.title, event.original, event.date, event.startDate, event.time, event.owner, event.source, event.notes]
        .some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }

  updateCalendarEvent(eventId, patch = {}) {
    const state = this.#load();
    const event = (Array.isArray(state.events) ? state.events : []).find((item) => String(item.id) === String(eventId));
    if (!event) return null;
    const allowed = ['title', 'original', 'date', 'startDate', 'time', 'endDate', 'endTime', 'notes', 'description', 'owner', 'status', 'source', 'recurrence', 'repeat', 'repeatUntil', 'runId', 'runFile'];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) event[key] = String(patch[key] || '');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'allDay')) event.allDay = Boolean(patch.allDay);
    event.kind = 'calendar-event';
    event.type = 'calendar-event';
    event.updatedAt = this.clock().toISOString();
    state.events = sortCalendarEvents(state.events);
    this.#touchAndSave(state);
    return event;
  }

  deleteCalendarEvent(eventId) {
    const state = this.#load();
    const events = Array.isArray(state.events) ? state.events : [];
    const index = events.findIndex((item) => String(item.id) === String(eventId));
    if (index === -1) return null;
    const [event] = events.splice(index, 1);
    state.events = events;
    this.#touchAndSave(state);
    return event;
  }

  migrateCalendarTasksToEvents() {
    const state = this.#load();
    const now = this.clock().toISOString();
    const events = new Map((Array.isArray(state.events) ? state.events : []).map((event) => [String(event.id), event]));
    const migrated = [];
    state.tasks = state.tasks.filter((task) => {
      if (!isCalendarTaskRecord(task)) return true;
      const event = {
        id: `event:${task.id}`,
        taskId: String(task.id),
        title: String(task.title || 'Calendar event'),
        original: String(task.original || task.title || ''),
        date: String(task.date || task.startDate || ''),
        startDate: String(task.startDate || task.date || ''),
        time: String(task.time || task.t || ''),
        endDate: String(task.endDate || task.dateEnd || ''),
        endTime: String(task.endTime || task.tEnd || ''),
        allDay: Boolean(task.allDay),
        recurrence: String(task.recurrence || task.repeat || ''),
        repeat: String(task.repeat || task.recurrence || ''),
        repeatUntil: String(task.repeatUntil || ''),
        notes: String(task.notes || task.body || ''),
        owner: String(task.owner || 'Me'),
        status: String(task.status || 'Planned'),
        source: 'legacy-calendar-task',
        kind: 'calendar-event',
        type: 'calendar-event',
        createdAt: task.createdAt || now,
        updatedAt: now,
      };
      events.set(event.id, event);
      migrated.push(event);
      return false;
    });
    state.events = sortCalendarEvents([...events.values()]).slice(0, 1500);
    this.#touchAndSave(state);
    return migrated;
  }

  createDocument(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const title = String(input.title || input.filename || 'Untitled document').trim();
    const content = String(input.extractedText || input.content || input.text || '').trim();
    const filename = String(input.filename || title).trim();
    const mimeType = String(input.mimeType || input.type || 'text/plain').trim();
    const size = Number(input.size || Buffer.byteLength(content, 'utf8') || 0);
    const ocrStatus = normalizeDocumentStatus(input.ocrStatus, content, input);
    const source = String(input.source || 'web').trim();
    const sourceLabel = String(input.sourceLabel || (source === 'telegram' ? 'Telegram' : source === 'web' ? 'Web upload' : source)).trim();
    const date = dateStamp(now);
    const document = normalizeDocumentRecord({
      id: createId('doc', this.clock),
      title,
      name: filename,
      filename,
      mimeType,
      type: documentTypeLabel(mimeType, filename),
      size,
      sizeLabel: formatByteSize(size),
      tags: extractTags('', input.tags || []),
      ocrStatus,
      ocr: ocrLabel(ocrStatus),
      extractedText: content,
      extract: content,
      summary: input.summary || (content ? '업로드된 증거에서 추출 텍스트를 기록했습니다.' : '파일 메타데이터를 기록했습니다. OCR 또는 원문 추출 대기 중입니다.'),
      source,
      sourceLabel,
      sourceId: input.sourceId || '',
      sourceChatId: input.sourceChatId || input.chatId || '',
      sourceMessageId: input.sourceMessageId || input.messageId || '',
      sourceUsername: input.sourceUsername || input.username || '',
      telegramFileId: input.telegramFileId || '',
      telegramFileUniqueId: input.telegramFileUniqueId || '',
      telegramFilePath: input.telegramFilePath || '',
      originalFilePath: input.originalFilePath || '',
      originalFileMimeType: input.originalFileMimeType || '',
      contentHash: input.contentHash || '',
      downloadedAt: input.downloadedAt || '',
      downloadStatus: input.downloadStatus || '',
      downloadError: input.downloadError || '',
      ocrEngine: input.ocrEngine || '',
      ocrProvider: input.ocrProvider || '',
      ocrCompletedAt: input.ocrCompletedAt || '',
      extractionMethod: input.extractionMethod || '',
      wikiPath: input.wikiPath || `1_raw/documents/${date}-${slugify(title, 'document')}.md`,
      date: compactDateLabel(now),
      createdAt: now,
      updatedAt: now,
    });
    state.documents.unshift(document);
    state.sessions.unshift({ time: now.slice(11, 16), text: `Document · ${document.title}`, state: document.ocrStatus });
    this.#touchAndSave(state);
    return document;
  }

  searchDocuments(query = '', options = {}) {
    const state = this.#load();
    const needle = String(query || '').trim().toLowerCase();
    const includeFixtures = Boolean(options.includeFixtures || options.includeTestFixtures || options.includeHidden);
    return state.documents.map(normalizeDocumentRecord).filter((document) => {
      if (!includeFixtures && document.evidenceVisible === false) return false;
      if (!needle) return true;
      return [
        document.title,
        document.filename,
        document.mimeType,
        document.extractedText,
        document.wikiPath,
        document.source,
        document.sourceLabel,
        document.sourceUsername,
        document.sourceMessageId,
        document.originalFilePath,
        document.telegramFilePath,
        ...(document.tags || []),
      ].some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }

  getDocument(documentId) {
    const state = this.#load();
    const document = state.documents.find((item) => item.id === documentId);
    return document ? normalizeDocumentRecord(document) : null;
  }

  registerTool(input = {}) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const name = String(input.name || input.displayName || 'Untitled tool').trim();
    const tool = {
      id: createId('tool', this.clock),
      name,
      type: normalizeToolType(input.type),
      category: String(input.category || 'general').trim(),
      description: String(input.description || '').trim(),
      command: String(input.command || '').trim(),
      sourcePath: String(input.sourcePath || input.path || '').trim(),
      status: normalizeToolStatus(input.status),
      riskLevel: normalizeToolRisk(input.riskLevel || input.risk),
      agents: normalizeStringArray(input.agents || input.agent || []),
      permissions: normalizeStringArray(input.permissions || []),
      createdAt: now,
      updatedAt: now,
      lastTest: null,
    };
    state.tools.unshift(tool);
    state.sessions.unshift({ time: now.slice(11, 16), text: `Tool · ${tool.name}`, state: tool.status });
    this.#touchAndSave(state);
    return tool;
  }

  searchTools(query = '', filters = {}) {
    const state = this.#load();
    const needle = String(query || '').trim().toLowerCase();
    const type = String(filters.type || '').trim().toLowerCase();
    const status = String(filters.status || '').trim().toLowerCase();
    return state.tools.filter((tool) => {
      if (type && tool.type.toLowerCase() !== type) return false;
      if (status && tool.status.toLowerCase() !== status) return false;
      if (!needle) return true;
      return [
        tool.name,
        tool.type,
        tool.category,
        tool.description,
        tool.command,
        tool.sourcePath,
        tool.riskLevel,
        ...(tool.agents || []),
        ...(tool.permissions || []),
      ].some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }

  getTool(toolId) {
    const state = this.#load();
    return state.tools.find((tool) => tool.id === toolId) || null;
  }

  updateTool(toolId, patch = {}) {
    const state = this.#load();
    const tool = state.tools.find((item) => item.id === toolId);
    if (!tool) return null;
    const allowed = ['name', 'category', 'description', 'command', 'sourcePath'];
    for (const key of allowed) {
      if (key in patch) tool[key] = String(patch[key] || '').trim();
    }
    if ('type' in patch) tool.type = normalizeToolType(patch.type);
    if ('status' in patch) tool.status = normalizeToolStatus(patch.status);
    if ('riskLevel' in patch || 'risk' in patch) tool.riskLevel = normalizeToolRisk(patch.riskLevel || patch.risk);
    if ('agents' in patch || 'agent' in patch) tool.agents = normalizeStringArray(patch.agents || patch.agent || []);
    if ('permissions' in patch) tool.permissions = normalizeStringArray(patch.permissions || []);
    tool.updatedAt = this.clock().toISOString();
    this.#touchAndSave(state);
    return tool;
  }

  recordToolTest(toolId, { run, status = 'queued' } = {}) {
    const state = this.#load();
    const tool = state.tools.find((item) => item.id === toolId);
    if (!tool) return null;
    tool.lastTest = {
      status,
      runId: run && run.id ? String(run.id) : '',
      runFile: run && run.file ? String(run.file) : '',
      checkedAt: this.clock().toISOString(),
    };
    tool.updatedAt = tool.lastTest.checkedAt;
    this.#touchAndSave(state);
    return tool;
  }

  listChatMessages({ limit = 80 } = {}) {
    const state = this.#load();
    const messages = Array.isArray(state.chatMessages) ? state.chatMessages : [];
    return messages.slice(-Number(limit || 80));
  }

  addChatMessage(input = {}) {
    const state = this.#load();
    if (!Array.isArray(state.chatMessages)) state.chatMessages = [];
    const now = this.clock().toISOString();
    const message = {
      id: createId('chat', this.clock),
      role: input.role || 'assistant',
      text: String(input.text || ''),
      runId: input.runId ? String(input.runId) : '',
      wikiPath: input.wikiPath ? String(input.wikiPath) : '',
      agent: input.agent ? String(input.agent) : '',
      model: input.model ? String(input.model) : '',
      source: input.source || 'chat',
      target: input.target ? String(input.target) : '',
      createdAt: now,
    };
    state.chatMessages.push(message);
    state.chatMessages = state.chatMessages.slice(-120);
    this.#touchAndSave(state);
    return message;
  }

  listCommandInbox({ limit = 50, source = '', includeArchived = false } = {}) {
    const state = this.#load();
    const archived = new Set(Array.isArray(state.commandInboxArchivedIds) ? state.commandInboxArchivedIds : []);
    const starred = new Set(Array.isArray(state.commandInboxStarredIds) ? state.commandInboxStarredIds : []);
    const items = [];

    (Array.isArray(state.chatMessages) ? state.chatMessages : [])
      .filter((message) => message.role === 'user' && message.text)
      .forEach((message) => {
        items.push({
          id: `chat:${message.id}`,
          rawId: message.id,
          source: 'web',
          sourceLabel: 'Web chat',
          title: message.text,
          text: message.text,
          receivedAt: message.createdAt || state.meta.createdAt,
          status: message.runId ? 'routed' : 'new',
          detail: message.runId ? `run ${message.runId}` : 'web command',
          runId: message.runId || '',
          wikiPath: message.wikiPath || '',
        });
      });

    (Array.isArray(state.telegramChatCandidates) ? state.telegramChatCandidates : [])
      .forEach((candidate) => {
        const chatId = String(candidate.chatId || '');
        const username = candidate.username ? `@${candidate.username}` : chatId;
        items.push({
          id: `telegram:${chatId}`,
          rawId: chatId,
          source: 'telegram',
          sourceLabel: `Telegram ${username}`.trim(),
          title: candidate.lastText || candidate.text || '',
          text: candidate.lastText || candidate.text || '',
          receivedAt: candidate.lastSeenAt || candidate.firstSeenAt || state.meta.createdAt,
          status: 'needs allow',
          detail: [candidate.reason || 'telegram command candidate', username].filter(Boolean).join(' · '),
          seenCount: candidate.seenCount || 1,
        });
      });

    (Array.isArray(state.ticktickTasks) ? state.ticktickTasks : [])
      .filter((task) => task.executable !== false)
      .forEach((task) => {
        items.push({
          id: `ticktick:${task.id}`,
          rawId: task.id,
          source: 'ticktick',
          sourceLabel: 'TickTick',
          title: task.title || task.original || '',
          text: task.original || task.title || '',
          receivedAt: task.importedAt || state.meta.createdAt,
          status: task.action || 'Run',
          detail: [task.tags, task.due].filter(Boolean).join(' · '),
        });
      });

    (Array.isArray(state.mailMessages) ? state.mailMessages : [])
      .forEach((message) => {
        items.push({
          id: message.id,
          rawId: message.messageId || message.id,
          source: message.provider || 'mail',
          sourceLabel: mailProviderLabel(message.provider),
          title: message.subject || '(no subject)',
          text: message.text || message.subject || '',
          receivedAt: message.receivedAt || message.importedAt || state.meta.createdAt,
          status: 'new',
          detail: message.from || message.accountId || 'mail',
          accountId: message.accountId || '',
          senderEmail: message.from || '',
        });
      });

    return items
      .filter((item) => includeArchived || !archived.has(item.id))
      .filter((item) => !source || item.source === source)
      .map((item) => ({ ...item, starred: starred.has(item.id), star: starred.has(item.id) }))
      .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
      .slice(0, Number(limit || 50));
  }

  getCommandInboxItem(itemId) {
    return this.listCommandInbox({ limit: 500, includeArchived: true })
      .find((item) => item.id === String(itemId || '')) || null;
  }

  archiveCommandInboxItem(itemId) {
    const state = this.#load();
    if (!Array.isArray(state.commandInboxArchivedIds)) state.commandInboxArchivedIds = [];
    const id = String(itemId || '');
    if (id && !state.commandInboxArchivedIds.includes(id)) {
      state.commandInboxArchivedIds.push(id);
      state.commandInboxArchivedIds = state.commandInboxArchivedIds.slice(-500);
      this.#touchAndSave(state);
    }
    return state.commandInboxArchivedIds;
  }

  setCommandInboxItemStarred(itemId, starred = true) {
    const state = this.#load();
    if (!Array.isArray(state.commandInboxStarredIds)) state.commandInboxStarredIds = [];
    const id = String(itemId || '');
    if (!id) return state.commandInboxStarredIds;
    if (starred && !state.commandInboxStarredIds.includes(id)) {
      state.commandInboxStarredIds.push(id);
      state.commandInboxStarredIds = state.commandInboxStarredIds.slice(-500);
      this.#touchAndSave(state);
    }
    if (!starred && state.commandInboxStarredIds.includes(id)) {
      state.commandInboxStarredIds = state.commandInboxStarredIds.filter((entry) => entry !== id);
      this.#touchAndSave(state);
    }
    return state.commandInboxStarredIds;
  }

  importTickTickText(text) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const imported = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(isExecutableTickTickTask)
      .map((line) => ({
        id: createId('task', this.clock),
        title: cleanTickTickTitle(line),
        original: line,
        tags: (line.match(/#\S+/g) || []).join(' '),
        action: 'Run',
        due: 'Imported',
        executable: true,
        importedAt: now,
      }));
    state.ticktickTasks.unshift(...imported);
    this.#touchAndSave(state);
    return imported;
  }

  importTickTickTasks(tasks = []) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const normalized = (Array.isArray(tasks) ? tasks : []).map((task) => ({
      id: String(task.id || createId('ticktick', this.clock)),
      title: String(task.title || task.original || ''),
      original: String(task.original || task.title || ''),
      content: String(task.content || ''),
      tags: Array.isArray(task.tags) ? task.tags.join(' ') : String(task.tags || ''),
      action: task.executable === false ? 'View' : 'Run',
      due: String(task.due || ''),
      startDate: String(task.startDate || ''),
      dueDate: String(task.dueDate || ''),
      projectId: String(task.projectId || task.ticktickProjectId || ''),
      ticktickProjectId: String(task.ticktickProjectId || task.projectId || ''),
      status: String(task.status || 'open'),
      completedTime: String(task.completedTime || ''),
      completedUserId: String(task.completedUserId || ''),
      executable: task.executable !== false,
      importedAt: now,
    })).filter((task) => task.title || task.original);
    const existing = new Map((Array.isArray(state.ticktickTasks) ? state.ticktickTasks : []).map((task) => [String(task.id), task]));
    normalized.forEach((task) => existing.set(String(task.id), { ...(existing.get(String(task.id)) || {}), ...task }));
    state.ticktickTasks = [...existing.values()]
      .sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')))
      .slice(0, 500);
    this.#touchAndSave(state);
    return normalized;
  }

  importTickTickTasksAsNative(tasks = [], options = {}) {
    const state = this.#load();
    const sourceTasks = Array.isArray(tasks) ? tasks : [];
    const force = Boolean(options.force);
    const existingByTickTickId = new Map((Array.isArray(state.tasks) ? state.tasks : [])
      .filter((task) => task.ticktickId || task.sourceId)
      .map((task) => [String(task.ticktickId || task.sourceId), task]));
    const imported = [];
    const skipped = [];
    for (const sourceTask of sourceTasks) {
      const ticktickId = String(sourceTask.id || sourceTask.taskId || '').trim();
      if (!ticktickId) {
        skipped.push({ reason: 'missing-ticktick-id', title: sourceTask.title || sourceTask.original || '' });
        continue;
      }
      if (!force && existingByTickTickId.has(ticktickId)) {
        skipped.push({ reason: 'already-imported', ticktickId, taskId: existingByTickTickId.get(ticktickId).id });
        continue;
      }
      const task = this.createTask({
        ...tickTickTaskToNativeInput(sourceTask),
        ticktickSyncedAt: this.clock().toISOString(),
      });
      imported.push(task);
      existingByTickTickId.set(ticktickId, task);
    }
    const nextState = this.#load();
    nextState.ticktickReplacement = {
      enabled: true,
      source: 'desktop-task-db',
      importedAt: this.clock().toISOString(),
      importedCount: imported.length,
      skippedCount: skipped.length,
      sourceCount: sourceTasks.length,
      mode: 'one-time-import',
    };
    nextState.systemConnections = {
      ...(nextState.systemConnections || {}),
      ticktick: {
        ...((nextState.systemConnections && nextState.systemConnections.ticktick) || {}),
        connected: false,
        state: 'replaced-by-hermes-task-db',
        detail: 'TickTick was imported once. Hermes desktop task DB is now the source of truth.',
        importedCount: sourceTasks.length,
      },
    };
    this.#touchAndSave(nextState);
    return {
      imported,
      skipped,
      replacement: nextState.ticktickReplacement,
    };
  }

  importMailMessages(messages = []) {
    const state = this.#load();
    if (!Array.isArray(state.mailMessages)) state.mailMessages = [];
    const normalized = (Array.isArray(messages) ? messages : [])
      .map((message) => normalizeMailMessage(message, this.clock))
      .filter((message) => message.accountId && (message.subject || message.text));
    const existing = new Map(state.mailMessages.map((message) => [String(message.id), message]));
    normalized.forEach((message) => existing.set(message.id, { ...(existing.get(message.id) || {}), ...message }));
    state.mailMessages = [...existing.values()]
      .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
      .slice(0, 500);
    this.#touchAndSave(state);
    return normalized;
  }

  setMailSyncStatus(status = {}) {
    const state = this.#load();
    state.mailSyncStatus = {
      checkedAt: status.checkedAt || this.clock().toISOString(),
      accounts: Array.isArray(status.accounts) ? status.accounts : [],
      importedCount: Number(status.importedCount || 0),
      ok: Boolean(status.ok),
      reason: String(status.reason || ''),
    };
    this.#touchAndSave(state);
    return state.mailSyncStatus;
  }

  setDaemonStatus(status = {}) {
    const state = this.#load();
    state.daemon = {
      ...(state.daemon || {}),
      ...status,
      intervalMs: Number(status.intervalMs || state.daemon?.intervalMs || 60000),
      updatedAt: this.clock().toISOString(),
    };
    this.#touchAndSave(state);
    return state.daemon;
  }

  importCalendarEvents(events = []) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const normalized = (Array.isArray(events) ? events : []).map((event) => ({
      ...event,
      id: String(event.id || createId('calendar', this.clock)),
      title: String(event.title || event.original || 'Calendar event'),
      original: String(event.original || event.title || ''),
      date: String(event.date || event.startDate || ''),
      d: Number(event.d || String(event.date || event.startDate || '').slice(8, 10) || 0),
      t: String(event.t || ''),
      tEnd: String(event.tEnd || ''),
      dateEnd: String(event.dateEnd || event.dueDate || event.endDate || ''),
      rangeLabel: String(event.rangeLabel || ''),
      o: String(event.o || event.owner || 'Agent'),
      st: String(event.st || event.status || 'Planned'),
      source: String(event.source || 'calendar'),
      importedAt: now,
    })).filter((event) => event.title && (event.date || event.d));
    const existing = new Map((Array.isArray(state.events) ? state.events : []).map((event) => [String(event.id), event]));
    normalized.forEach((event) => existing.set(String(event.id), { ...(existing.get(String(event.id)) || {}), ...event }));
    state.events = [...existing.values()]
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || Number(a.d || 0) - Number(b.d || 0) || String(a.t || '').localeCompare(String(b.t || '')))
      .slice(0, 1500);
    this.#touchAndSave(state);
    return normalized;
  }

  importExternalCalendarEvents(events = []) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const normalized = (Array.isArray(events) ? events : []).map((event) => ({
      id: String(event.id || createId('calendar', this.clock)),
      title: String(event.title || event.original || 'Calendar event'),
      original: String(event.original || event.title || ''),
      startDate: String(event.startDate || event.date || ''),
      dueDate: String(event.dueDate || event.endDate || ''),
      calendarId: String(event.calendarId || ''),
      calendarName: String(event.calendarName || ''),
      source: String(event.source || 'ticktick-calendar'),
      sourceLabel: String(event.sourceLabel || 'External calendar'),
      importedAt: now,
    })).filter((event) => event.title && event.startDate);
    const existing = new Map((Array.isArray(state.externalCalendarEvents) ? state.externalCalendarEvents : []).map((event) => [String(event.id), event]));
    normalized.forEach((event) => existing.set(String(event.id), { ...(existing.get(String(event.id)) || {}), ...event }));
    state.externalCalendarEvents = [...existing.values()]
      .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')))
      .slice(0, 1000);
    this.#touchAndSave(state);
    return normalized;
  }

  addReflection(reflection) {
    const state = this.#load();
    state.reflections.unshift(reflection);
    this.#touchAndSave(state);
    return reflection;
  }

  addSkillCandidate(candidate) {
    const state = this.#load();
    state.skillCandidates.unshift([
      candidate.name,
      candidate.evidence,
      String(candidate.score),
      candidate.target,
    ]);
    this.#touchAndSave(state);
    return candidate;
  }

  setRemoteVerification(verification) {
    const state = this.#load();
    const checkedAt = this.clock().toISOString();
    state.remoteVerification = {
      reachable: Boolean(verification && verification.reachable),
      status: Number(verification && verification.status) || 0,
      url: verification && verification.url ? verification.url : '',
      name: verification && verification.name ? verification.name : '',
      error: verification && verification.error ? verification.error : '',
      resolver: verification && verification.resolver ? verification.resolver : '',
      diagnostics: verification && verification.diagnostics && typeof verification.diagnostics === 'object'
        ? verification.diagnostics
        : {},
      checkedAt,
    };
    this.#touchAndSave(state);
    return state.remoteVerification;
  }

  addTelegramChatCandidate(candidate) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const chatId = String(candidate && candidate.chatId ? candidate.chatId : '');
    const agentId = String(candidate && candidate.agentId ? candidate.agentId : 'default');
    const username = candidate && candidate.username ? String(candidate.username) : '';
    const text = candidate && candidate.text ? String(candidate.text).slice(0, 500) : '';
    const reason = candidate && candidate.reason ? String(candidate.reason) : '';
    if (!chatId) return null;
    const existing = state.telegramChatCandidates.find((item) => (
      item.chatId === chatId
      && String(item.agentId || 'default') === agentId
    ));
    if (existing) {
      existing.agentId = agentId;
      existing.username = username || existing.username;
      existing.lastText = text;
      existing.reason = reason || existing.reason;
      existing.lastSeenAt = now;
      existing.seenCount = Number(existing.seenCount || 1) + 1;
      this.#touchAndSave(state);
      return existing;
    }
    const record = {
      chatId,
      agentId,
      username,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
      lastText: text,
      reason,
    };
    state.telegramChatCandidates.unshift(record);
    this.#touchAndSave(state);
    return record;
  }

  setTelegramWebhookStatus({ webhookUrl, result, error, registrations = [] } = {}) {
    const state = this.#load();
    const ok = Boolean(result && result.ok !== false && !error);
    const safeRegistrations = (Array.isArray(registrations) ? registrations : [])
      .filter((registration) => isOfficialProfileName(registration?.agentId))
      .map((registration) => ({
        agentId: String(registration.agentId),
        webhookUrl: sanitizeWebhookUrl(registration.webhookUrl),
        registered: registration.registered === true,
        description: sanitizeTelegramStatusText(registration.description),
      }));
    state.telegramWebhook = {
      registered: ok,
      webhookUrl: sanitizeWebhookUrl(webhookUrl),
      checkedAt: this.clock().toISOString(),
      description: sanitizeTelegramStatusText(result?.description),
      error: sanitizeTelegramStatusText(error),
      registrations: safeRegistrations,
    };
    this.#touchAndSave(state);
    return state.telegramWebhook;
  }

  removeTelegramChatCandidate(chatId) {
    const state = this.#load();
    const normalizedChatId = String(chatId || '');
    const before = state.telegramChatCandidates.length;
    state.telegramChatCandidates = state.telegramChatCandidates.filter((item) => item.chatId !== normalizedChatId);
    if (state.telegramChatCandidates.length !== before) this.#touchAndSave(state);
    return state.telegramChatCandidates;
  }

  updateRunFile(runId, relativePath) {
    const state = this.#load();
    const run = state.runs.find((item) => item.id === runId);
    if (run) {
      run.file = relativePath;
      this.#touchAndSave(state);
    }
    return run;
  }

  getRun(runId) {
    const state = this.#load();
    return state.runs.find((item) => item.id === runId) || null;
  }

  updateRunStatus(runId, status) {
    const state = this.#load();
    const run = state.runs.find((item) => item.id === runId);
    if (run) {
      run.status = status;
      run.updatedAt = this.clock().toISOString();
      this.#touchAndSave(state);
    }
    return run || null;
  }

  appendRunLog(runId, line) {
    const state = this.#load();
    const run = state.runs.find((item) => item.id === runId);
    if (run) {
      run.logs = run.logs || [];
      run.logs.push(line);
      state.sessions.unshift({ time: this.clock().toISOString().slice(11, 16), text: `${run.agent} · ${line}`, state: run.status || 'Running' });
      this.#touchAndSave(state);
    }
    return run || null;
  }

  createSchedulerJob(input) {
    const state = this.#load();
    const now = this.clock().toISOString();
    const intervalMinutes = Number(input.intervalMinutes) || 60;
    const job = {
      id: createId('job', this.clock),
      name: input.name || slugify(input.goal || 'scheduled-job', 'scheduled-job'),
      goal: input.goal || 'Scheduled Hermes run',
      agent: resolveRequestedOfficialProfile({ agentId: input.agentId, agent: input.agent }),
      model: input.model || 'Recommended',
      intervalMinutes: Math.max(1, intervalMinutes),
      enabled: input.enabled !== false,
      lastRunAt: input.lastRunAt || '',
      lastRunId: input.lastRunId || '',
      runCount: Number(input.runCount || 0),
      createdAt: now,
    };
    state.schedulerJobs.unshift(job);
    this.#touchAndSave(state);
    return job;
  }

  getSchedulerJobs() {
    const state = this.#load();
    return state.schedulerJobs;
  }

  updateSchedulerJob(jobId, patch) {
    const state = this.#load();
    const job = state.schedulerJobs.find((item) => item.id === jobId);
    if (job) {
      const safePatch = { ...(patch || {}) };
      if (
        Object.prototype.hasOwnProperty.call(safePatch, 'agent')
        || Object.prototype.hasOwnProperty.call(safePatch, 'agentId')
      ) {
        safePatch.agent = resolveRequestedOfficialProfile({
          agentId: safePatch.agentId,
          agent: safePatch.agent,
          fallback: job.agent,
        });
        delete safePatch.agentId;
      }
      Object.assign(job, safePatch, { updatedAt: this.clock().toISOString() });
      delete job.agentId;
      this.#touchAndSave(state);
    }
    return job || null;
  }

  deleteSchedulerJob(jobId) {
    const state = this.#load();
    const index = state.schedulerJobs.findIndex((item) => item.id === jobId);
    if (index === -1) return null;
    const [job] = state.schedulerJobs.splice(index, 1);
    this.#touchAndSave(state);
    return job;
  }

  listWorkboardPages() {
    const state = this.#load();
    return state.workboardPages;
  }

  createWorkboardPage(input = {}) {
    const state = this.#load();
    const page = normalizeWorkboardPage(input, this.clock);
    state.workboardPages.unshift(page);
    this.#touchAndSave(state);
    return page;
  }

  updateWorkboardPage(pageId, patch = {}) {
    const state = this.#load();
    const index = state.workboardPages.findIndex((page) => page.id === pageId);
    if (index === -1) return null;
    const current = state.workboardPages[index];
    const page = normalizeWorkboardPage({
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.clock().toISOString(),
    }, this.clock);
    state.workboardPages[index] = page;
    this.#touchAndSave(state);
    return page;
  }

  deleteWorkboardPage(pageId) {
    const state = this.#load();
    const index = state.workboardPages.findIndex((page) => page.id === pageId);
    if (index === -1) return null;
    const [page] = state.workboardPages.splice(index, 1);
    this.#touchAndSave(state);
    return page;
  }

  #findAgent(state, agentId, agentName, profileAgents = []) {
    const wanted = resolveProductAgentName({ agentId, agent: agentName });
    const officialWanted = isOfficialProfileName(wanted) ? wanted : '';
    return resolveHermesAgent(state, {
      agentId: officialWanted || agentId,
      agent: wanted || agentName,
    }, { profileAgents })
      || state.agents.find((agent) => agent.id === (officialWanted || agentId))
      || state.agents.find((agent) => agent.displayName === wanted || agent.name === wanted)
      || (officialWanted ? createOfficialProfileAgent(officialWanted) : null)
      || (wanted ? {
        id: wanted,
        displayName: wanted,
        name: wanted,
        model: 'Recommended',
        agentSource: 'ad-hoc',
        agentIdentity: {
          id: wanted,
          displayName: wanted,
          source: 'ad-hoc',
          resident: false,
          kind: 'ad-hoc-agent',
        },
      } : null)
      || state.agents[0]
      || { id: 'agent-default', displayName: 'Hermes', name: 'Hermes', model: 'Recommended' };
  }

  #load({ persistDefault = true } = {}) {
    if (this.atomicState) return this.atomicState;
    if (!fs.existsSync(this.statePath)) {
      const state = createDefaultState(this.clock().toISOString());
      if (persistDefault) this.#save(state);
      return state;
    }
    return this.#normalizeState(JSON.parse(fs.readFileSync(this.statePath, 'utf8')));
  }

  #normalizeState(state) {
    if (!Array.isArray(state.agentMissions)) state.agentMissions = [];
    if (!Array.isArray(state.agentSessions)) state.agentSessions = [];
    if (!Array.isArray(state.agentSessionEvents)) state.agentSessionEvents = [];
    if (!Array.isArray(state.agentReports)) state.agentReports = [];
    if (!Array.isArray(state.schedulerJobs)) state.schedulerJobs = [];
    if (!Array.isArray(state.deletedAgentIds)) state.deletedAgentIds = [];
    if (!state.daemon || typeof state.daemon !== 'object') {
      state.daemon = {
        running: false,
        intervalMs: 60000,
        lastRun: null,
        lastError: null,
      };
    }
    if (!Array.isArray(state.documents)) state.documents = [];
    state.documents = state.documents.map(normalizeDocumentRecord);
    if (!Array.isArray(state.workboardPages)) state.workboardPages = [];
    state.workboardPages = state.workboardPages.map((page) => normalizeWorkboardPage(page, this.clock));
    if (!Array.isArray(state.tools)) state.tools = [];
    if (!Array.isArray(state.mailMessages)) state.mailMessages = [];
    if (!('remoteVerification' in state)) state.remoteVerification = null;
    if (!('telegramWebhook' in state)) state.telegramWebhook = null;
    if (!Array.isArray(state.telegramChatCandidates)) state.telegramChatCandidates = [];
    if (!Array.isArray(state.commandInboxArchivedIds)) state.commandInboxArchivedIds = [];
    return state;
  }

  #touchAndSave(state) {
    state.meta.updatedAt = this.clock().toISOString();
    if (this.atomicState === state) {
      this.atomicWriteRequested = true;
      return;
    }
    this.#save(state);
  }

  #runAtomic(operation) {
    if (this.atomicState) throw new Error('Nested file-store transaction is not supported');
    const original = this.#load();
    this.atomicState = JSON.parse(JSON.stringify(original));
    this.atomicWriteRequested = false;
    try {
      const result = operation();
      if (result && typeof result.then === 'function') {
        throw new Error('File-store transaction operation must be synchronous');
      }
      if (this.atomicWriteRequested) this.#save(this.atomicState);
      return result;
    } finally {
      this.atomicState = null;
      this.atomicWriteRequested = false;
    }
  }

  #save(state) {
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

module.exports = {
  HermesStore,
  cleanTickTickTitle,
  createDefaultState,
  isExecutableTickTickTask,
  sanitizeWebhookUrl,
};
