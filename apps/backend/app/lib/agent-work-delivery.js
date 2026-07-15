class AgentWorkDeliveryError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AgentWorkDeliveryError';
    this.code = code;
    this.status = status;
  }
}

const COMMAND_PATTERNS = Object.freeze({
  pause: /^(?:(?:please|kindly)\s+|(?:(?:could|would|can)\s+you(?:\s+please|\s+kindly)?\s+))?(?:pause|stop)(?:\s+(?:this|the))?\s*(?:work|task)?(?:\s+please)?[.!?]?$/i,
  cancel: /^(?:(?:please|kindly)\s+|(?:(?:could|would|can)\s+you(?:\s+please|\s+kindly)?\s+))?cancel(?:\s+(?:(?:this|the)\s*(?:work|task)?|it))?(?:\s+please)?[.!?]?$/i,
  resume: /^(?:(?:please|kindly)\s+|(?:(?:could|would|can)\s+you(?:\s+please|\s+kindly)?\s+))?resume(?:\s+(?:this|the))?\s*(?:work|task)?(?:\s+please)?[.!?]?$/i,
  retry: /^(?:(?:please|kindly)\s+|(?:(?:could|would|can)\s+you(?:\s+please|\s+kindly)?\s+))?(?:retry(?:\s+(?:this|the))?\s*(?:work|task)?|try\s+again)(?:\s+please)?[.!?]?$/i,
});

const KOREAN_COMMAND_PATTERNS = Object.freeze({
  pause: /^(?:(?:이\s*)?작업(?:을|은|이)?\s*(?:일시\s*정지|중지|멈춤|멈춰)(?:해)?|(?:잠깐\s*)?멈춰(?:해)?)\s*(?:줘|주세요)?[.!?]?$/i,
  cancel: /^(?:(?:이\s*)?작업(?:을|은|이)?\s*취소(?:해)?|그만(?:해)?)\s*(?:줘|주세요)?[.!?]?$/i,
  resume: /^(?:이\s*)?작업(?:을|은|이)?\s*(?:재개|계속)(?:해)?\s*(?:줘|주세요)?[.!?]?$/i,
  retry: /^(?:(?:이\s*)?작업(?:을|은|이)?\s*(?:재\s*시도|다시\s*시도)(?:해)?|다시\s*해)\s*(?:줘|주세요)?[.!?]?$/i,
});

const ENGLISH_ACTION = '(?:send|e-?mail|mail|upload|share|transfer|deliver|forward|distribute|notify|publish|post|purchase|buy|sell|order|trade|delete|remove|wipe|erase|reset|change)';
const ENGLISH_BASE_EXTERNAL_ACTION = '(?:(?:place|execute)\\s+(?:a\\s+)?trade|send|e-?mail|mail|upload|share|transfer|deliver|forward|distribute|notify|publish|purchase|buy|sell|order|trade|delete|remove|wipe|erase|post(?!-))';
const ENGLISH_GERUND_EXTERNAL_ACTION = '(?:sending|e-?mailing|mailing|uploading|sharing|transferring|delivering|forwarding|distributing|notifying|publishing|purchasing|buying|selling|ordering|trading|deleting|removing|wiping|erasing|posting)';
const ENGLISH_EXTERNAL_REQUEST_START = `(?:(?:(?:please|kindly)\\s+)?(?:proceed\\s+to\\s+)?${ENGLISH_BASE_EXTERNAL_ACTION}|(?:(?:could|would|can|will)\\s+you(?:\\s+(?:please|kindly))?\\s+)(?:proceed\\s+to\\s+)?${ENGLISH_BASE_EXTERNAL_ACTION}|would\\s+you\\s+mind\\s+${ENGLISH_GERUND_EXTERNAL_ACTION})`;
const ENGLISH_NEGATED_ACTION = new RegExp(`\\bwithout\\b[^.!?;]{0,80}\\b${ENGLISH_ACTION}(?:ing)?\\b|\\b(?:do\\s+not|don['’]t|not(?:\\s+to)?)\\s+(?:actually\\s+)?${ENGLISH_ACTION}\\b`, 'i');
const ENGLISH_EDITING_CONTEXT = /\b(?:wording|draft|plan|phrase|sentence|sections?|paragraphs?|conclusion|examples?(?!\.[a-z])|references?|ambiguity|explanation|analysis|comparison|versus|vs\.?|risk|behavior|clarity|how)\b/i;
const ENGLISH_EDITING_INTENT = /\b(?:analy[sz]e|explain|describe|review|edit|refine|clarify|compare|summarize|draft|write|compose|revise|delete|remove|wipe|erase|reset|change|buy|purchase|e-?mail|mail)\b/i;
const ENGLISH_EXTERNAL_IMPERATIVE = new RegExp(`(?:^|:\\s*)${ENGLISH_EXTERNAL_REQUEST_START}\\b`, 'i');
const ENGLISH_SPACED_ACTIONS = Object.freeze([
  'send', 'email', 'mail', 'upload', 'share', 'transfer', 'deliver', 'forward', 'distribute',
  'notify', 'publish', 'post', 'purchase', 'buy', 'sell', 'order', 'trade', 'delete', 'remove',
]);
const ENGLISH_ARTIFACT = /\b(?:reports?|files?|documents?|evidence|attachments?|summaries|updates?|artifacts?|folders?|data)\b/i;
const ENGLISH_DIRECT_EXTERNAL_RECIPIENT = /\b(?:e-?mail|mail)(?:ed|ing|s)?\s+(?:(?:the|a|our|my|this)\s+)?(?:vendor|client|customer|team|third[ -]?part(?:y|ies)|public)\b/i;
const ENGLISH_SENSITIVE_OBJECT = /\b(?:credentials?|passwords?|tokens?|api\s+keys?|secrets?)\b/i;
const ENGLISH_EXTERNAL_DESTINATION = /\b(?:(?:to|with|via|by|into|onto)\s+(?:(?:the|a)\s+)?(?:e-?mail|google\s+drive|drive|slack|workspace|vendor|client|customer|team|third[ -]?part(?:y|ies)|public(?:\s+channel)?|me)|outside(?:\s+the)?(?:\s+(?:organization|company))?|publicly|externally)\b/i;
const ENGLISH_DESTRUCTIVE_RESOURCE = /\b(?:files?|folders?|accounts?|data|databases?|credentials?|passwords?|tokens?|api\s+keys?|(?:remote|shared)\s+documents?)\b/i;
const ENGLISH_PURCHASE_OBJECT = /\b(?:subscriptions?|licenses?|products?|items?|plans?|services?|tickets?|seats?)\b/i;

const KOREAN_EXTERNAL_ACTION = '(?:이메일|메일|보내|발송|공유|전송|전달|넘겨|공지|게시|발행|업로드|올려|구매|결제|주문|삭제|제거|폐기|초기화|거래|매수|매도|포스트|포스팅|퍼블리시|센드|쉐어|바이|오더|트레이드|딜리트|리무브)';
const KOREAN_NEGATED_ACTION = new RegExp(`${KOREAN_EXTERNAL_ACTION}(?:하|해)?지\\s*(?:말고|마세요|않고|않게|말아)`, 'i');
const KOREAN_EDITING_CONTEXT = /(?:분석|설명|문구|초안|결론|예시|참조|중복|방법|방안|계획|위험|비교|모호|동작)/i;
const KOREAN_EDITING_INTENT = /(?:(?:분석|설명|비교|작성)(?:해|하)|다듬|수정|편집|검토|요약|삭제|제거)/i;
const KOREAN_EXTERNAL_IMPERATIVE = new RegExp(`(?:(?:${KOREAN_EXTERNAL_ACTION})(?:하|해)?|(?:사|팔아))\\s*(?:줘|주세요|주시겠어요|주시겠습니까|줄래|줄래요|부탁해|부탁해요|부탁드립니다)(?:[.!?]|$)`, 'i');
const KOREAN_ARTIFACT = /(?:보고서|파일|증거|문서|첨부|요약|업데이트|자료|데이터|폴더)/i;
const KOREAN_SENSITIVE_OBJECT = /(?:자격\s*증명|비밀\s*번호|토큰|API\s*키|비밀)/i;
const KOREAN_EXTERNAL_DESTINATION = /(?:(?:고객사?|외부\s*업체|제삼자|제3자|클라이언트)(?:에|에게|로)|(?:구글\s*)?드라이브(?:에|로)|슬랙(?:에|으로)|워크스페이스(?:에|로)|이메일(?:에|로)|외부로|공개)/i;
const KOREAN_DESTRUCTIVE_RESOURCE = /(?:파일|폴더|계정|데이터|데이터베이스|DB|자격\s*증명|비밀\s*번호|토큰|API\s*키)/i;
const KOREAN_PURCHASE_OBJECT = /(?:라이선스|구독|상품|제품|서비스|티켓|좌석)/i;

function hasEnglishInternalOverride(text) {
  if (ENGLISH_NEGATED_ACTION.test(text)) return true;
  return ENGLISH_EDITING_CONTEXT.test(text) && ENGLISH_EDITING_INTENT.test(text);
}

function isEnglishExternalRequest(text) {
  if (hasEnglishInternalOverride(text)) return false;
  if (ENGLISH_EXTERNAL_IMPERATIVE.test(text)) return true;
  if (/\b(?:e-?mail|mail)(?:ed|ing|s)?\b/i.test(text)) {
    return ENGLISH_ARTIFACT.test(text)
      || ENGLISH_EXTERNAL_DESTINATION.test(text)
      || ENGLISH_DIRECT_EXTERNAL_RECIPIENT.test(text);
  }
  if (/\bupload(?:ed|ing|s)?\b/i.test(text)) {
    return ENGLISH_ARTIFACT.test(text) || ENGLISH_EXTERNAL_DESTINATION.test(text);
  }
  if (/\binvit(?:e|ed|ing|es)\b/i.test(text)) return ENGLISH_EXTERNAL_DESTINATION.test(text);
  if (/\bpublish(?:ed|ing|es)?\b|\bpost(?!-)(?:ed|ing|s)?\b/i.test(text)) {
    return ENGLISH_ARTIFACT.test(text) || ENGLISH_EXTERNAL_DESTINATION.test(text);
  }
  if (/\b(?:purchase(?:d|s|ing)?|buy|buys|buying|bought)\b/i.test(text)) {
    return ENGLISH_PURCHASE_OBJECT.test(text);
  }
  if (/\border(?:ed|ing|s)?\b/i.test(text)) return ENGLISH_PURCHASE_OBJECT.test(text);
  if (/\b(?:delete|remove|wipe|erase)(?:d|s|ing)?\b/i.test(text)) {
    return ENGLISH_DESTRUCTIVE_RESOURCE.test(text);
  }
  if (/\b(?:reset|change|rotate|revoke)(?:s|d|ing)?\b/i.test(text)) {
    return ENGLISH_SENSITIVE_OBJECT.test(text);
  }
  if (/\bnotify(?:ied|ing|ies)?\b/i.test(text)) {
    return ENGLISH_EXTERNAL_DESTINATION.test(text)
      || /\b(?:vendor|client|customer|team|third[ -]?part(?:y|ies)|public)\b/i.test(text);
  }
  if (/\b(?:send|share|transfer|deliver|forward|distribute)(?:s|ed|ing)?\b/i.test(text)) {
    return ENGLISH_EXTERNAL_DESTINATION.test(text) || ENGLISH_SENSITIVE_OBJECT.test(text);
  }
  return false;
}

function hasKoreanInternalOverride(text) {
  return KOREAN_NEGATED_ACTION.test(text)
    || (KOREAN_EDITING_CONTEXT.test(text) && KOREAN_EDITING_INTENT.test(text));
}

function isKoreanExternalRequest(text) {
  const compact = text.replace(/\s+/g, '');
  if (hasKoreanInternalOverride(text)) return false;
  if (KOREAN_EXTERNAL_IMPERATIVE.test(compact)) return true;
  if (/^(?:포스트|포스팅|퍼블리시)$/i.test(compact)) return true;
  if (/(?:이메일|메일)(?:하|해|보내)/i.test(compact)) {
    return KOREAN_ARTIFACT.test(compact) || KOREAN_EXTERNAL_DESTINATION.test(compact);
  }
  if (/(?:업로드|올려|올리)/i.test(compact)) {
    return KOREAN_ARTIFACT.test(compact) || KOREAN_EXTERNAL_DESTINATION.test(compact);
  }
  if (/(?:초대)/i.test(compact)) return KOREAN_EXTERNAL_DESTINATION.test(compact);
  if (/(?:게시|발행)/i.test(compact)) {
    return KOREAN_ARTIFACT.test(compact) || KOREAN_EXTERNAL_DESTINATION.test(compact);
  }
  if (/(?:구매|결제|주문)/i.test(compact)) return KOREAN_PURCHASE_OBJECT.test(compact) || /상품|제품|서비스|구독/.test(compact);
  if (/(?:삭제|제거|폐기|초기화)/i.test(compact)) return KOREAN_DESTRUCTIVE_RESOURCE.test(compact);
  if (/(?:재설정|변경|초기화)/i.test(compact) && KOREAN_SENSITIVE_OBJECT.test(compact)) return true;
  if (/(?:공지)/i.test(compact)) return /고객|고객사|외부업체|제삼자|제3자|클라이언트|팀|공개/.test(compact);
  if (/(?:보내|발송|공유|전송|전달|넘겨|넘기)/i.test(compact)) {
    return KOREAN_EXTERNAL_DESTINATION.test(compact);
  }
  return false;
}

function normalizeClassifierText(text) {
  const normalized = String(text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ENGLISH_SPACED_ACTIONS.reduce((value, action) => (
    value.replace(new RegExp(`\\b${[...action].join('\\s+')}\\b`, 'gi'), action)
  ), normalized);
}

function actionableClauses(text) {
  return text
    .split(new RegExp(`(?:(?:[!?;]\\s*|\\.(?:\\s+|$))|(?:^|[.!?;]\\s*)[^.!?;]{0,160}\\b(?:do\\s+not|don['’]t)\\b[^,]{0,160},\\s*(?=${ENGLISH_EXTERNAL_REQUEST_START}\\b)|(?:^|[.!?;]\\s*)[^.!?;]{0,160}(?:하지|지)\\s*말고\\s*(?=[^.!?;]{0,120}${KOREAN_EXTERNAL_ACTION})|,?\\s+then\\s+|,?\\s+and\\s+then\\s+|,?\\s+(?:and|plus)\\s+(?=${ENGLISH_EXTERNAL_REQUEST_START}\\b)|\\s+하고\\s+(?=${ENGLISH_EXTERNAL_REQUEST_START}\\b)|,?\\s+but\\s+|,?\\s*(?:그\\s*다음|그런\\s*다음|이후|하지만|그리고)\\s*|(?:검토|분석|수정|편집|설명)(?:하고|한\\s*다음|\\s*후)\\s*|(?:analy[sz]e|explain|describe|review|edit|refine|clarify|compare|summarize|draft|write|compose|revise)(?:하고|한\\s*다음)\\s*)`, 'i'))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function withoutQuotedWording(clause) {
  if (!ENGLISH_EDITING_CONTEXT.test(clause) && !KOREAN_EDITING_CONTEXT.test(clause)) return clause;
  return clause.replace(/["“”']([^"“”']+)["“”']/g, ' ');
}

function isUnsupportedExternalRequest(text) {
  const value = normalizeClassifierText(text);
  const clauseSource = withoutQuotedWording(value);
  return actionableClauses(clauseSource).some((clause) => {
    const actionable = withoutQuotedWording(clause);
    return isEnglishExternalRequest(actionable) || isKoreanExternalRequest(actionable);
  });
}

function deliveryFromEvent(event = {}) {
  const metadata = event.metadata || {};
  return {
    status: metadata.deliveryStatus || 'accepted',
    applicationMode: metadata.applicationMode || 'mission_context',
    acceptedAt: metadata.acceptedAt || event.createdAt,
    ...(metadata.appliedAt ? { appliedAt: metadata.appliedAt } : {}),
    ...(metadata.targetTaskId ? { targetTaskId: metadata.targetTaskId } : {}),
    ...(metadata.revisionId ? { revisionId: metadata.revisionId } : {}),
  };
}

function taskPriority(task) {
  return ['running', 'failed', 'blocked', 'scheduled', 'proposed', 'completed'].indexOf(task.status);
}

function missionTasks(state, missionId) {
  return state.tasks
    .filter((task) => task.missionId === missionId && task.origin === 'agent')
    .sort((left, right) => (
      taskPriority(left) - taskPriority(right)
      || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
      || String(left.id).localeCompare(String(right.id))
    ));
}

function explicitCommand(text) {
  const normalized = normalizeClassifierText(text);
  const english = Object.entries(COMMAND_PATTERNS)
    .find(([, pattern]) => pattern.test(normalized))?.[0];
  if (english) return english;
  return Object.entries(KOREAN_COMMAND_PATTERNS)
    .find(([, pattern]) => pattern.test(normalized))?.[0] || '';
}

function commandTarget(tasks, action) {
  const allowed = {
    pause: ['running', 'scheduled'],
    cancel: ['running', 'proposed', 'scheduled', 'blocked'],
    resume: ['blocked'],
    retry: ['failed'],
  }[action];
  return tasks.find((task) => allowed.includes(task.status));
}

function classifyWorkDelivery({ state, missionId, text } = {}) {
  if (isUnsupportedExternalRequest(text)) {
    return {
      kind: 'unsupported_external',
      delivery: {
        status: 'rejected',
        applicationMode: 'unsupported_external_request',
      },
    };
  }
  const tasks = missionTasks(state, missionId);
  const action = explicitCommand(text);
  if (action) {
    const target = commandTarget(tasks, action);
    if (!target) {
      throw new AgentWorkDeliveryError(
        'invalid_task_transition',
        `No task can ${action} from its current state`,
        409,
      );
    }
    if (
      action === 'resume'
      && (target.failureCode === 'budget_exhausted' || target.blockedReason === 'budget_exhausted')
    ) {
      throw new AgentWorkDeliveryError(
        'budget_approval_required',
        'Explicit budget approval is required before this task can resume',
        409,
      );
    }
    if (action === 'resume' && target.failureCode === 'relay_cancel_unconfirmed') {
      throw new AgentWorkDeliveryError(
        'relay_cancel_unconfirmed',
        'Remote Hermes cancellation must be confirmed before this task can resume',
        409,
      );
    }
    const deferred = target.status === 'running' && ['pause', 'cancel'].includes(action);
    return {
      kind: 'command',
      action,
      target,
      deferred,
      delivery: {
        status: 'accepted',
        applicationMode: deferred ? 'next_checkpoint' : 'state_transition',
        targetTaskId: target.id,
      },
    };
  }
  const target = tasks.find((task) => ['running', 'scheduled', 'proposed', 'failed'].includes(task.status));
  if (target) {
    return {
      kind: 'ordinary',
      delivery: {
        status: 'queued',
        applicationMode: 'next_attempt',
        targetTaskId: target.id,
      },
    };
  }
  return {
    kind: 'ordinary',
    delivery: { status: 'accepted', applicationMode: 'mission_context' },
  };
}

function deliveryMetadata(delivery, acceptedAt) {
  return {
    deliveryStatus: delivery.status,
    applicationMode: delivery.applicationMode,
    acceptedAt,
    ...(delivery.appliedAt ? { appliedAt: delivery.appliedAt } : {}),
    ...(delivery.targetTaskId ? { targetTaskId: delivery.targetTaskId } : {}),
    ...(delivery.revisionId ? { revisionId: delivery.revisionId } : {}),
  };
}

function markEventApplied(store, event, appliedAt) {
  return store.updateAgentSessionEvent(event.id, {
    metadata: {
      ...(event.metadata || {}),
      deliveryStatus: 'applied',
      appliedAt,
    },
  });
}

function markMissionContextApplied({ store, missionId, appliedAt } = {}) {
  const state = store.getState();
  const sessionIds = new Set(state.agentSessions
    .filter((session) => session.missionId === missionId && session.type === 'mission-thread')
    .map((session) => session.id));
  return state.agentSessionEvents
    .filter((event) => (
      sessionIds.has(event.sessionId)
      && event.kind === 'user_message'
      && event.metadata?.deliveryStatus === 'accepted'
      && event.metadata?.applicationMode === 'mission_context'
      && !event.metadata?.appliedAt
    ))
    .map((event) => markEventApplied(store, event, appliedAt));
}

function queuedEventsForTask(store, missionId, taskId) {
  const state = store.getState();
  const conversationIds = new Set(state.agentSessions
    .filter((session) => session.missionId === missionId && session.type === 'mission-thread')
    .map((session) => session.id));
  return state.agentSessionEvents.filter((event) => (
    conversationIds.has(event.sessionId)
    && event.kind === 'user_message'
    && event.metadata?.deliveryStatus === 'queued'
    && event.metadata?.applicationMode === 'next_attempt'
    && event.metadata?.targetTaskId === taskId
    && !event.metadata?.appliedAt
  ));
}

function markCheckpointRequestApplied({ store, taskId, action, appliedAt } = {}) {
  const events = store.getState().agentSessionEvents.filter((event) => (
    event.kind === 'user_message'
    && event.metadata?.targetTaskId === taskId
    && event.metadata?.applicationMode === 'next_checkpoint'
    && event.metadata?.action === action
    && !event.metadata?.appliedAt
  ));
  return events.map((event) => markEventApplied(store, event, appliedAt));
}

module.exports = {
  AgentWorkDeliveryError,
  classifyWorkDelivery,
  deliveryFromEvent,
  deliveryMetadata,
  markCheckpointRequestApplied,
  markEventApplied,
  markMissionContextApplied,
  isUnsupportedExternalRequest,
  queuedEventsForTask,
};
