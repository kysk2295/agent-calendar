'use strict';

const crypto = require('node:crypto');
const { assertWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const {
  classifyCalendarAiIntent,
  parseAutomationChange,
  parseCalendarCreate,
  parseDelegatedWork,
} = require('./calendar-ai-context');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function reject(code, message, statusHint = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.statusHint = statusHint;
  throw error;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function publicMemory(row) {
  return {
    id: row.id,
    label: row.label,
    value: row.value,
    status: row.status,
    provenance: object(row.provenance),
    retentionUntil: row.retention_until,
    forgottenAt: row.forgotten_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    actionKind: row.action_kind,
    status: row.status,
    input: object(row.input),
    policy: object(row.policy),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicReceipt(row) {
  return {
    id: row.id,
    draftId: row.draft_id,
    status: row.status,
    operation: row.operation,
    result: object(row.result),
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
  };
}

function exactAnswer(rangeLabel, entries, coverage) {
  const incomplete = coverage.filter((item) => item.state !== 'complete');
  const coverageText = incomplete.length
    ? `일부 소스의 조회 범위가 완전하지 않습니다: ${incomplete.map((item) => item.label || item.sourceId).join(', ')}.`
    : '연결된 일정 소스의 조회 범위가 모두 확인되었습니다.';
  if (!entries.length) {
    return `${rangeLabel} 일정은 없습니다.\n\n${coverageText}`;
  }
  const lines = entries.map((entry) => {
    const start = String(entry.startsAt || '');
    const time = entry.allDay
      ? '종일'
      : new Intl.DateTimeFormat('ko-KR', {
        timeZone: entry.timezone || 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(start));
    return `- ${time} ${entry.title}`;
  });
  return `${rangeLabel} 일정은 총 ${entries.length}개입니다.\n${lines.join('\n')}\n\n${coverageText}`;
}

function matchingCalendarEvent(events, message) {
  const normalizedMessage = String(message || '').replace(/\s+/g, ' ').trim();
  return [...events]
    .filter((event) => event?.title && normalizedMessage.includes(String(event.title)))
    .sort((left, right) => String(right.title).length - String(left.title).length)[0] || null;
}

function matchingAutomation(automations, targetName, message) {
  const normalized = `${targetName || ''} ${message || ''}`.replace(/\s+/g, ' ').trim();
  return [...automations]
    .filter((automation) => (
      automation?.name
      && normalized.includes(String(automation.name))
    ))
    .sort((left, right) => String(right.name).length - String(left.name).length)[0] || null;
}

function calendarTimePatch(message, event) {
  const match = String(message || '').match(/(오전|오후)?\s*(\d{1,2})(?::(\d{2}))?\s*시/);
  if (!match) return {};
  let hour = Number(match[2]);
  if (match[1] === '오후' && hour < 12) hour += 12;
  if (match[1] === '오전' && hour === 12) hour = 0;
  const minute = match[3] ? Number(match[3]) : 0;
  const offsetMs = 9 * 60 * 60 * 1000;
  const originalStart = new Date(event.startsAt);
  const local = new Date(originalStart.getTime() + offsetMs);
  const startsAt = new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    hour,
    minute,
  ) - offsetMs);
  const originalEnd = event.endsAt ? new Date(event.endsAt) : null;
  const duration = originalEnd && Number.isFinite(originalEnd.getTime())
    ? Math.max(0, originalEnd.getTime() - originalStart.getTime())
    : 60 * 60 * 1000;
  return {
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + duration).toISOString(),
  };
}

class CalendarAiService {
  constructor({
    pool,
    product,
    unifiedCalendar,
    knowledge = null,
    automationFederation = null,
    durableExecution,
    modelAdapter,
    env = process.env,
    clock = () => Date.now(),
  } = {}) {
    this.pool = pool;
    this.product = product;
    this.unifiedCalendar = unifiedCalendar;
    this.knowledge = knowledge;
    this.automationFederation = automationFederation;
    this.durableExecution = durableExecution;
    this.modelAdapter = modelAdapter;
    this.env = env;
    this.clock = clock;
  }

  enabled() {
    return !/^(0|false|off|no)$/i.test(String(this.env.CALENDAR_AI_V2_ENABLED ?? '1'));
  }

  actionsEnabled() {
    return !/^(0|false|off|no)$/i.test(String(this.env.CALENDAR_AI_ACTIONS_ENABLED ?? '1'));
  }

  async #activeMemories(scope) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const rows = await client.query(
        `select * from calendar_ai_memories
         where workspace_id = $1
           and status = 'active'
           and (retention_until is null or retention_until > now())
         order by updated_at desc`,
        [valid.workspaceId],
      );
      return rows.rows.map(publicMemory);
    });
  }

  async #beginTurn(scope, { conversationId, message, requestId }) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      await client.query(
        `select pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [valid.workspaceId, requestId],
      );
      const replay = await client.query(
        `select t.*, c.id as conversation_id
         from calendar_ai_turns t
         inner join calendar_ai_conversations c
           on c.workspace_id = t.workspace_id and c.id = t.conversation_id
         where t.workspace_id = $1
           and t.client_request_id = $2
         limit 1`,
        [valid.workspaceId, requestId],
      );
      if (replay.rowCount) {
        const response = object(replay.rows[0].metadata).response;
        return {
          conversationId: replay.rows[0].conversation_id,
          userTurnId: replay.rows[0].id,
          replay: response && typeof response === 'object' ? response : null,
          resumed: true,
        };
      }

      let targetConversationId = String(conversationId || '');
      if (targetConversationId) {
        const existing = await client.query(
          `select id from calendar_ai_conversations
           where workspace_id = $1 and id = $2 and status = 'active'
           for update`,
          [valid.workspaceId, targetConversationId],
        );
        if (!existing.rowCount) reject('CONVERSATION_NOT_FOUND', 'conversation not found', 404);
      } else {
        targetConversationId = newId('caic');
        await client.query(
          `insert into calendar_ai_conversations (
             id, workspace_id, created_by_user_id, title, latest_turn_at
           ) values ($1,$2,$3,$4,now())`,
          [targetConversationId, valid.workspaceId, valid.userId, message.slice(0, 120)],
        );
      }
      const next = await client.query(
        `select coalesce(max(sequence), 0)::int + 1 as sequence
         from calendar_ai_turns
         where workspace_id = $1 and conversation_id = $2`,
        [valid.workspaceId, targetConversationId],
      );
      const userTurnId = newId('cait');
      await client.query(
        `insert into calendar_ai_turns (
           id, workspace_id, conversation_id, sequence, role, kind, text,
           client_request_id, metadata
         ) values ($1,$2,$3,$4,'user','message',$5,$6,'{}'::jsonb)`,
        [
          userTurnId,
          valid.workspaceId,
          targetConversationId,
          next.rows[0].sequence,
          message,
          requestId,
        ],
      );
      await client.query(
        `update calendar_ai_conversations
         set latest_turn_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, targetConversationId],
      );
      return {
        conversationId: targetConversationId,
        userTurnId,
        replay: null,
        resumed: false,
      };
    });
  }

  async #conversationMessages(scope, conversationId) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const rows = await client.query(
        `select role, kind, text, metadata from calendar_ai_turns
         where workspace_id = $1 and conversation_id = $2
         order by sequence desc
         limit 20`,
        [valid.workspaceId, conversationId],
      );
      return rows.rows
        .reverse()
        .filter((row) => {
          if (String(row.kind || '').startsWith('memory_')) return false;
          const responseMode = String(object(row.metadata).response?.mode || '');
          return !responseMode.startsWith('memory_');
        })
        .map((row) => ({
          role: row.role === 'assistant' ? 'assistant' : 'user',
          content: row.text,
        }));
    });
  }

  async #completeModel(scope, conversationId, message, {
    memories,
    knowledgeResults = [],
    requestId = '',
  } = {}) {
    const history = await this.#conversationMessages(scope, conversationId);
    const memoryText = memories.length
      ? `사용자가 명시적으로 저장한 개인 기억:\n${memories.map((memory) => `- ${memory.value}`).join('\n')}`
      : '저장된 개인 기억 없음.';
    const knowledgeText = knowledgeResults.length
      ? `현재 허용된 Workspace 지식 근거:\n${knowledgeResults.map((item) => `- ${item.title}: ${item.excerpt}`).join('\n')}`
      : '';
    const messages = [
      {
        role: 'system',
        content: [
          '당신은 Agent Calendar의 Calendar AI다.',
          '자연스럽게 한국어로 대화하되, 제공되지 않은 일정이나 사실을 만들지 않는다.',
          '모델 출력은 어떤 도구 권한도 갖지 않으며 행동을 실행했다고 주장하면 안 된다.',
          memoryText,
          knowledgeText,
        ].filter(Boolean).join('\n\n'),
      },
      ...history,
    ];
    if (!history.length || history.at(-1).content !== message) {
      messages.push({ role: 'user', content: message });
    }
    return this.modelAdapter.complete({
      messages,
      scope,
      purpose: 'calendar_ai',
      conversationId,
      requestId,
      context: {
        memories: memories.map((memory) => ({ id: memory.id, value: memory.value })),
        ...(knowledgeResults.length
          ? { knowledge: knowledgeResults.map((item) => ({ handle: item.handle, title: item.title, excerpt: item.excerpt })) }
          : {}),
      },
    });
  }

  async #finishTurn(scope, {
    conversationId,
    userTurnId,
    requestId,
    answer,
    mode,
    sources = [],
    coverage = [],
    range = null,
    memoryIds = [],
    model = null,
    action = null,
  }) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const existingUser = await client.query(
        `select metadata from calendar_ai_turns
         where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, userTurnId],
      );
      if (!existingUser.rowCount) reject('TURN_NOT_FOUND', 'turn not found', 404);
      const existingResponse = object(existingUser.rows[0].metadata).response;
      if (existingResponse && typeof existingResponse === 'object') return existingResponse;
      const next = await client.query(
        `select coalesce(max(sequence), 0)::int + 1 as sequence
         from calendar_ai_turns
         where workspace_id = $1 and conversation_id = $2`,
        [valid.workspaceId, conversationId],
      );
      const assistantTurnId = newId('cait');
      await client.query(
        `insert into calendar_ai_turns (
           id, workspace_id, conversation_id, sequence, role, kind, text, metadata
         ) values ($1,$2,$3,$4,'assistant',$5,$6,$7::jsonb)`,
        [
          assistantTurnId,
          valid.workspaceId,
          conversationId,
          next.rows[0].sequence,
          mode,
          answer,
          JSON.stringify({ model: model || null, replyTo: userTurnId }),
        ],
      );

      let draft = null;
      if (action) {
        const draftId = newId('caia');
        await client.query(
          `insert into calendar_ai_action_drafts (
             id, workspace_id, conversation_id, turn_id, action_kind, status,
             input, policy, idempotency_key, expires_at
           ) values (
             $1,$2,$3,$4,$5,'pending_approval',$6::jsonb,$7::jsonb,$8,
             now() + interval '24 hours'
           )`,
          [
            draftId,
            valid.workspaceId,
            conversationId,
            assistantTurnId,
            action.actionKind,
            JSON.stringify(action.input),
            JSON.stringify({
              requiresApproval: true,
              capability: action.actionKind,
              authorizedFrom: 'explicit_user_turn',
              modelCannotApprove: true,
            }),
            `turn:${requestId}`,
          ],
        );
        const draftRow = await client.query(
          `select * from calendar_ai_action_drafts
           where workspace_id = $1 and id = $2`,
          [valid.workspaceId, draftId],
        );
        draft = publicDraft(draftRow.rows[0]);
      }

      const snapshotId = newId('cctx');
      const digest = crypto.createHash('sha256').update(JSON.stringify({
        mode,
        range,
        coverage,
        sources: sources.map((item) => item.id || item.handle),
        memoryIds,
      })).digest('hex');
      await client.query(
        `insert into calendar_ai_context_snapshots (
           id, workspace_id, conversation_id, turn_id, query_kind,
           range_start, range_end, coverage, source_refs, knowledge_handles,
           memory_ids, context_digest
         ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,
        [
          snapshotId,
          valid.workspaceId,
          conversationId,
          assistantTurnId,
          mode,
          range?.from || null,
          range?.to || null,
          JSON.stringify(coverage),
          JSON.stringify(sources),
          JSON.stringify(sources.map((item) => item.handle).filter(Boolean)),
          JSON.stringify(memoryIds),
          digest,
        ],
      );
      const response = {
        ok: true,
        conversationId,
        turnId: assistantTurnId,
        answer,
        mode,
        sources,
        coverage,
        range,
        model: model || null,
        actionDraft: draft,
        workspaceId: valid.workspaceId,
      };
      await client.query(
        `update calendar_ai_turns
         set metadata = jsonb_set(metadata, '{response}', $3::jsonb, true)
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, userTurnId, JSON.stringify(response)],
      );
      await client.query(
        `update calendar_ai_conversations
         set latest_turn_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, conversationId],
      );
      return response;
    });
  }

  async chat(scope, {
    conversationId = '',
    message = '',
    requestId = '',
  } = {}) {
    assertWorkspaceScope(scope);
    if (!this.enabled()) reject('CALENDAR_AI_V2_DISABLED', 'Calendar AI v2 disabled', 403);
    const text = String(message || '').trim();
    if (!text) reject('MESSAGE_REQUIRED', 'message required', 400);
    const normalizedRequestId = String(requestId || newId('req')).slice(0, 200);
    const started = await this.#beginTurn(scope, {
      conversationId,
      message: text,
      requestId: normalizedRequestId,
    });
    if (started.replay) return started.replay;
    const intent = classifyCalendarAiIntent(text, this.clock());
    const memories = await this.#activeMemories(scope);

    if (intent.kind === 'memory_create') {
      const value = text
        .replace(/기억해\s*줘|기억해줘|기억해\s*둬|기억해둬/g, '')
        .trim() || text;
      const memory = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
        const id = newId('caim');
        await client.query(
          `insert into calendar_ai_memories (
             id, workspace_id, label, value, status, provenance, created_by_user_id
           ) values ($1,$2,'사용자 요청',$3,'active',$4::jsonb,$5)`,
          [
            id,
            valid.workspaceId,
            value,
            JSON.stringify({
              kind: 'explicit_user_request',
              conversationId: started.conversationId,
              userTurnId: started.userTurnId,
            }),
            valid.userId,
          ],
        );
        const row = await client.query(
          `select * from calendar_ai_memories where workspace_id = $1 and id = $2`,
          [valid.workspaceId, id],
        );
        return publicMemory(row.rows[0]);
      });
      return this.#finishTurn(scope, {
        conversationId: started.conversationId,
        userTurnId: started.userTurnId,
        requestId: normalizedRequestId,
        answer: `개인 기억에 저장했습니다: ${memory.value}`,
        mode: 'memory_created',
        memoryIds: [memory.id],
      });
    }

    if (intent.kind === 'memory_forget') {
      const active = memories[0];
      if (active) await this.forgetMemory(scope, active.id);
      return this.#finishTurn(scope, {
        conversationId: started.conversationId,
        userTurnId: started.userTurnId,
        requestId: normalizedRequestId,
        answer: active ? '해당 개인 기억을 잊었습니다.' : '지울 활성 개인 기억이 없습니다.',
        mode: 'memory_forgotten',
      });
    }

    if (intent.kind === 'exact_schedule') {
      const result = await this.unifiedCalendar.queryRange(scope, intent.range);
      return this.#finishTurn(scope, {
        conversationId: started.conversationId,
        userTurnId: started.userTurnId,
        requestId: normalizedRequestId,
        answer: exactAnswer(intent.range.label, result.entries, result.coverage),
        mode: 'exact_schedule',
        sources: result.entries,
        coverage: result.coverage,
        range: intent.range,
        memoryIds: memories.map((memory) => memory.id),
      });
    }

    if (
      [
        'calendar_create',
        'calendar_update',
        'calendar_delete',
        'delegate_work',
        'automation_change',
      ].includes(intent.kind)
      && this.actionsEnabled()
    ) {
      let action;
      if (intent.kind === 'automation_change') {
        if (!this.automationFederation) {
          reject('AUTOMATION_FEDERATION_UNAVAILABLE', 'automation federation unavailable', 503);
        }
        const parsed = parseAutomationChange(text);
        const sourceResult = await this.automationFederation.listSources(scope);
        const automationResult = await this.automationFederation.listAutomations(scope);
        const source = sourceResult.sources.find((item) => text.includes(item.displayName))
          || sourceResult.sources[0]
          || null;
        const target = matchingAutomation(
          automationResult.automations,
          parsed.targetName,
          text,
        );
        action = {
          actionKind: 'automation_change',
          input: {
            sourceId: target?.sourceId || source?.id || '',
            automationId: parsed.operation === 'create' ? '' : target?.id || '',
            operation: parsed.operation,
            expectedRevision: target?.sourceRevision || '',
            changeInput: parsed.input,
            targetName: parsed.targetName,
            resolution: target || parsed.operation === 'create'
              ? 'resolved'
              : source
                ? 'target_required'
                : 'source_required',
          },
        };
      } else if (intent.kind === 'calendar_create') {
        const input = parseCalendarCreate(text, this.clock());
        input.eventId = `event_calai_${crypto.createHash('sha256').update(`${scope.workspaceId}:${normalizedRequestId}`).digest('hex').slice(0, 20)}`;
        action = { actionKind: 'calendar_create', input };
      } else if (intent.kind === 'delegate_work') {
        const input = parseDelegatedWork(text);
        input.missionId = `mission_calai_${crypto.createHash('sha256').update(`${scope.workspaceId}:${normalizedRequestId}`).digest('hex').slice(0, 20)}`;
        action = { actionKind: 'delegate_work', input };
      } else {
        const events = await this.product.listCalendarEvents(scope);
        const target = matchingCalendarEvent(events, text);
        action = {
          actionKind: intent.kind,
          input: target
            ? {
              eventId: target.id,
              title: target.title,
              ...(intent.kind === 'calendar_update'
                ? { patch: calendarTimePatch(text, target) }
                : {}),
            }
            : { requestedText: text, resolution: 'target_required' },
        };
      }
      return this.#finishTurn(scope, {
        conversationId: started.conversationId,
        userTurnId: started.userTurnId,
        requestId: normalizedRequestId,
        answer: '요청한 작업을 실행 전 초안으로 준비했습니다. 내용을 확인하고 승인해 주세요.',
        mode: 'action_draft',
        memoryIds: memories.map((memory) => memory.id),
        action,
      });
    }

    let knowledgeResults = [];
    if (intent.kind === 'knowledge' && this.knowledge?.enabled()) {
      const result = await this.knowledge.search(scope, {
        query: text,
        mode: 'hybrid',
        requestId: `calendar-ai:${normalizedRequestId}`,
      });
      knowledgeResults = result.results || [];
    }
    let completion;
    try {
      completion = await this.#completeModel(scope, started.conversationId, text, {
        memories,
        knowledgeResults,
        requestId: normalizedRequestId,
      });
    } catch (error) {
      completion = {
        text: '지금은 대화 모델에 연결할 수 없습니다. 일정은 계속 직접 확인하고 수정할 수 있습니다.',
        provider: 'unavailable',
        model: '',
        errorCode: error.code || 'CALENDAR_AI_MODEL_UNAVAILABLE',
      };
    }
    return this.#finishTurn(scope, {
      conversationId: started.conversationId,
      userTurnId: started.userTurnId,
      requestId: normalizedRequestId,
      answer: completion.text,
      mode: intent.kind === 'knowledge' ? 'knowledge_conversation' : 'conversation',
      sources: knowledgeResults,
      memoryIds: memories.map((memory) => memory.id),
      model: {
        provider: completion.provider,
        model: completion.model,
        errorCode: completion.errorCode || '',
      },
    });
  }

  async listConversations(scope) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const rows = await client.query(
        `select * from calendar_ai_conversations
         where workspace_id = $1
         order by latest_turn_at desc nulls last, created_at desc`,
        [valid.workspaceId],
      );
      return {
        ok: true,
        conversations: rows.rows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          latestTurnAt: row.latest_turn_at,
          createdAt: row.created_at,
        })),
        workspaceId: valid.workspaceId,
      };
    });
  }

  async listConversation(scope, conversationId) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const conversation = await client.query(
        `select * from calendar_ai_conversations
         where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(conversationId || '')],
      );
      if (!conversation.rowCount) return null;
      const turns = await client.query(
        `select * from calendar_ai_turns
         where workspace_id = $1 and conversation_id = $2
         order by sequence asc`,
        [valid.workspaceId, conversation.rows[0].id],
      );
      const drafts = await client.query(
        `select * from calendar_ai_action_drafts
         where workspace_id = $1 and conversation_id = $2
         order by created_at asc`,
        [valid.workspaceId, conversation.rows[0].id],
      );
      const snapshots = await client.query(
        `select * from calendar_ai_context_snapshots
         where workspace_id = $1 and conversation_id = $2`,
        [valid.workspaceId, conversation.rows[0].id],
      );
      const snapshotByTurn = new Map(snapshots.rows.map((row) => [row.turn_id, row]));
      const draftByTurn = new Map(drafts.rows.map((row) => [row.turn_id, row]));
      return {
        ok: true,
        conversation: {
          id: conversation.rows[0].id,
          title: conversation.rows[0].title,
          status: conversation.rows[0].status,
          turns: turns.rows.map((row) => {
            const snapshot = snapshotByTurn.get(row.id);
            const actionDraft = draftByTurn.get(row.id);
            return {
              id: row.id,
              sequence: row.sequence,
              role: row.role,
              kind: row.kind,
              text: row.text,
              metadata: object(row.metadata),
              sources: Array.isArray(snapshot?.source_refs) ? snapshot.source_refs : [],
              coverage: Array.isArray(snapshot?.coverage) ? snapshot.coverage : [],
              actionDraft: actionDraft ? publicDraft(actionDraft) : null,
              createdAt: row.created_at,
            };
          }),
          actionDrafts: drafts.rows.map(publicDraft),
        },
        workspaceId: valid.workspaceId,
      };
    });
  }

  async listMemories(scope) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const rows = await client.query(
        `select * from calendar_ai_memories
         where workspace_id = $1
         order by updated_at desc`,
        [valid.workspaceId],
      );
      return {
        ok: true,
        memories: rows.rows.map(publicMemory),
        workspaceId: valid.workspaceId,
      };
    });
  }

  async updateMemory(scope, memoryId, patch = {}) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const value = String(patch.value || '').trim();
      const label = String(patch.label || '사용자 요청').trim();
      if (!value) reject('MEMORY_VALUE_REQUIRED', 'memory value required', 400);
      const row = await client.query(
        `update calendar_ai_memories
         set value = $3, label = $4, status = 'active', forgotten_at = null, updated_at = now()
         where workspace_id = $1 and id = $2
         returning *`,
        [valid.workspaceId, String(memoryId || ''), value, label],
      );
      if (!row.rowCount) reject('MEMORY_NOT_FOUND', 'memory not found', 404);
      return { ok: true, memory: publicMemory(row.rows[0]), workspaceId: valid.workspaceId };
    });
  }

  async forgetMemory(scope, memoryId) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const row = await client.query(
        `update calendar_ai_memories
         set status = 'forgotten', forgotten_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2
         returning *`,
        [valid.workspaceId, String(memoryId || '')],
      );
      if (!row.rowCount) reject('MEMORY_NOT_FOUND', 'memory not found', 404);
      return { ok: true, memory: publicMemory(row.rows[0]), workspaceId: valid.workspaceId };
    });
  }

  async purgeMemory(scope, memoryId) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const row = await client.query(
        `delete from calendar_ai_memories
         where workspace_id = $1 and id = $2
         returning id`,
        [valid.workspaceId, String(memoryId || '')],
      );
      if (!row.rowCount) reject('MEMORY_NOT_FOUND', 'memory not found', 404);
      return { ok: true, purged: true, memoryId: row.rows[0].id, workspaceId: valid.workspaceId };
    });
  }

  async #loadDraft(scope, draftId) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const receipt = await client.query(
        `select r.* from calendar_ai_action_receipts r
         where r.workspace_id = $1 and r.draft_id = $2 limit 1`,
        [valid.workspaceId, String(draftId || '')],
      );
      const draft = await client.query(
        `select * from calendar_ai_action_drafts
         where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(draftId || '')],
      );
      if (!draft.rowCount) reject('ACTION_DRAFT_NOT_FOUND', 'action draft not found', 404);
      return {
        draft: draft.rows[0],
        receipt: receipt.rowCount ? receipt.rows[0] : null,
      };
    });
  }

  async approveAction(scope, draftId, { requestId = '' } = {}) {
    assertWorkspaceScope(scope);
    const loaded = await this.#loadDraft(scope, draftId);
    if (loaded.receipt) {
      return {
        ok: loaded.receipt.status === 'succeeded',
        draft: publicDraft(loaded.draft),
        receipt: publicReceipt(loaded.receipt),
        idempotentReplay: true,
      };
    }
    if (loaded.draft.status === 'cancelled') {
      reject('ACTION_DRAFT_CANCELLED', 'action draft cancelled', 409);
    }
    const input = object(loaded.draft.input);
    const approvalRequestId = String(requestId || loaded.draft.idempotency_key).slice(0, 200);
    let result;
    let actionReceiptStatus = 'succeeded';
    let actionDraftStatus = 'completed';
    if (loaded.draft.action_kind === 'calendar_create') {
      const existing = await this.product.getCalendarEventById(scope, input.eventId);
      const event = existing || await this.product.createCalendarEvent(scope, {
        id: input.eventId,
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone || 'Asia/Seoul',
        source: 'calendar-ai',
      });
      result = { eventId: event.id, event };
    } else if (loaded.draft.action_kind === 'calendar_update') {
      if (!input.eventId) reject('ACTION_TARGET_REQUIRED', 'calendar update target required', 409);
      const event = await this.product.updateCalendarEvent(scope, input.eventId, object(input.patch));
      if (!event) reject('ACTION_TARGET_NOT_FOUND', 'calendar event not found', 404);
      result = { eventId: event.id, event };
    } else if (loaded.draft.action_kind === 'calendar_delete') {
      if (!input.eventId) reject('ACTION_TARGET_REQUIRED', 'calendar delete target required', 409);
      const deleted = await this.product.deleteCalendarEvent(scope, input.eventId);
      if (!deleted) reject('ACTION_TARGET_NOT_FOUND', 'calendar event not found', 404);
      result = { eventId: input.eventId, deleted: true };
    } else if (loaded.draft.action_kind === 'automation_change') {
      if (!this.automationFederation) {
        reject('AUTOMATION_FEDERATION_UNAVAILABLE', 'automation federation unavailable', 503);
      }
      if (!input.sourceId) reject('ACTION_SOURCE_REQUIRED', 'automation source required', 409);
      if (input.operation !== 'create' && !input.automationId) {
        reject('ACTION_TARGET_REQUIRED', 'automation target required', 409);
      }
      let automationChange = await this.automationFederation.requestChange(scope, {
        sourceId: input.sourceId,
        automationId: input.automationId || '',
        operation: input.operation,
        expectedRevision: input.expectedRevision || '',
        requestId: `calendar-ai:${approvalRequestId}`,
        input: object(input.changeInput),
      });
      if (automationChange.change?.status === 'pending_approval') {
        automationChange = await this.automationFederation.approveChange(
          scope,
          automationChange.change.id,
          { requestId: `calendar-ai-approval:${approvalRequestId}` },
        );
      }
      const sourceStatus = automationChange.receipt?.status || 'failed';
      actionReceiptStatus = ['succeeded', 'unknown', 'conflict'].includes(sourceStatus)
        ? sourceStatus
        : 'failed';
      actionDraftStatus = sourceStatus === 'succeeded'
        ? 'completed'
        : sourceStatus === 'unknown' || sourceStatus === 'conflict'
          ? sourceStatus
          : 'failed';
      result = {
        automationChangeId: automationChange.change?.id || '',
        automationReceipt: automationChange.receipt,
        automation: automationChange.automation,
      };
    } else if (loaded.draft.action_kind === 'delegate_work') {
      const existing = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
        const row = await client.query(
          `select id, mission_id, session_id, status
           from execution_jobs
           where workspace_id = $1 and mission_id = $2 limit 1`,
          [valid.workspaceId, input.missionId],
        );
        return row.rowCount ? row.rows[0] : null;
      });
      if (existing) {
        result = {
          missionId: existing.mission_id,
          jobId: existing.id,
          sessionId: existing.session_id,
          status: existing.status,
        };
      } else {
        const work = await this.durableExecution.acceptWork(scope, {
          missionId: input.missionId,
          title: input.title,
          goal: input.goal,
          agentId: input.agentId || 'default',
          executionEngine: input.executionEngine || 'auto',
          clientRequestId: `calendar-ai:${approvalRequestId}`,
          templateId: 'calendar-ai-delegation',
          payload: {
            kind: 'calendar_ai_delegated_work',
            calendarAiConversationId: loaded.draft.conversation_id,
            calendarAiDraftId: loaded.draft.id,
            calendarAiTurnId: loaded.draft.turn_id,
          },
        });
        result = {
          missionId: work.missionId,
          jobId: work.jobId,
          sessionId: work.sessionId,
          status: work.status,
          conversationId: loaded.draft.conversation_id,
        };
      }
    } else {
      reject('ACTION_KIND_UNSUPPORTED', 'action kind unsupported', 400);
    }

    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const existing = await client.query(
        `select * from calendar_ai_action_receipts
         where workspace_id = $1 and draft_id = $2 limit 1`,
        [valid.workspaceId, loaded.draft.id],
      );
      if (existing.rowCount) {
        return {
          ok: existing.rows[0].status === 'succeeded',
          draft: publicDraft(loaded.draft),
          receipt: publicReceipt(existing.rows[0]),
          idempotentReplay: true,
        };
      }
      const receiptId = newId('cair');
      await client.query(
        `insert into calendar_ai_action_receipts (
           id, workspace_id, draft_id, status, operation, result
         ) values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          receiptId,
          valid.workspaceId,
          loaded.draft.id,
          actionReceiptStatus,
          loaded.draft.action_kind,
          JSON.stringify(result),
        ],
      );
      const updated = await client.query(
        `update calendar_ai_action_drafts
         set status = $4, approved_by_user_id = $3,
             approved_at = coalesce(approved_at, now()), updated_at = now()
         where workspace_id = $1 and id = $2
         returning *`,
        [valid.workspaceId, loaded.draft.id, valid.userId, actionDraftStatus],
      );
      const receipt = await client.query(
        `select * from calendar_ai_action_receipts
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, receiptId],
      );
      return {
        ok: actionReceiptStatus === 'succeeded',
        draft: publicDraft(updated.rows[0]),
        receipt: publicReceipt(receipt.rows[0]),
        idempotentReplay: false,
      };
    });
  }

  async reviseAction(scope, draftId, patch = {}) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const row = await client.query(
        `update calendar_ai_action_drafts
         set input = input || $3::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2 and status = 'pending_approval'
         returning *`,
        [valid.workspaceId, String(draftId || ''), JSON.stringify(object(patch.input || patch))],
      );
      if (!row.rowCount) reject('ACTION_DRAFT_NOT_REVISABLE', 'action draft not revisable', 409);
      return { ok: true, actionDraft: publicDraft(row.rows[0]), workspaceId: valid.workspaceId };
    });
  }

  async cancelAction(scope, draftId) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const row = await client.query(
        `update calendar_ai_action_drafts
         set status = 'cancelled', cancelled_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2 and status = 'pending_approval'
         returning *`,
        [valid.workspaceId, String(draftId || '')],
      );
      if (!row.rowCount) reject('ACTION_DRAFT_NOT_CANCELLABLE', 'action draft not cancellable', 409);
      return { ok: true, actionDraft: publicDraft(row.rows[0]), workspaceId: valid.workspaceId };
    });
  }
}

module.exports = {
  CalendarAiService,
  exactAnswer,
};
