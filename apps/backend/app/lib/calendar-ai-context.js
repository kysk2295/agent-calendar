'use strict';

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function seoulParts(nowMs) {
  const date = new Date(nowMs + SEOUL_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function seoulStartMs({ year, month, day }) {
  return Date.UTC(year, month, day) - SEOUL_OFFSET_MS;
}

function exactRange(message, nowMs) {
  const parts = seoulParts(nowMs);
  const base = seoulStartMs(parts);
  if (/모레/.test(message)) {
    return { from: new Date(base + 2 * DAY_MS).toISOString(), to: new Date(base + 3 * DAY_MS).toISOString(), label: '모레' };
  }
  if (/내일/.test(message)) {
    return { from: new Date(base + DAY_MS).toISOString(), to: new Date(base + 2 * DAY_MS).toISOString(), label: '내일' };
  }
  if (/다음\s*주/.test(message)) {
    const mondayOffset = parts.weekday === 0 ? -6 : 1 - parts.weekday;
    const start = base + (mondayOffset + 7) * DAY_MS;
    return { from: new Date(start).toISOString(), to: new Date(start + 7 * DAY_MS).toISOString(), label: '다음 주' };
  }
  if (/이번\s*주|금주/.test(message)) {
    const mondayOffset = parts.weekday === 0 ? -6 : 1 - parts.weekday;
    const start = base + mondayOffset * DAY_MS;
    return { from: new Date(start).toISOString(), to: new Date(start + 7 * DAY_MS).toISOString(), label: '이번 주' };
  }
  if (/이번\s*달|이번\s*월/.test(message)) {
    const start = seoulStartMs({ year: parts.year, month: parts.month, day: 1 });
    const end = seoulStartMs({ year: parts.year, month: parts.month + 1, day: 1 });
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), label: '이번 달' };
  }
  return { from: new Date(base).toISOString(), to: new Date(base + DAY_MS).toISOString(), label: '오늘' };
}

function quotedOrExplanatory(message) {
  return /문자열|인용|예시|설명해|번역해|분석해|코드로만|대화로만/.test(message);
}

function classifyCalendarAiIntent(messageValue, nowMs = Date.now()) {
  const message = String(messageValue || '').trim();
  if (!message) return { kind: 'invalid' };
  if (/기억해\s*줘|기억해줘|기억해\s*둬|기억해둬/.test(message)) {
    return { kind: 'memory_create' };
  }
  if (/잊어\s*줘|기억에서\s*(지워|삭제)|기억을\s*(지워|삭제)/.test(message)) {
    return { kind: 'memory_forget' };
  }
  if (!quotedOrExplanatory(message)) {
    if (
      /(자동화|오토메이션|cron)/i.test(message)
      && /(만들|생성|추가|수정|변경|바꿔|일시\s*정지|중지|멈춰|재개|다시\s*활성|실행)/.test(message)
    ) {
      return { kind: 'automation_change' };
    }
    if (/에이전트.*위임|위임해\s*줘|맡겨\s*줘/.test(message)) {
      return { kind: 'delegate_work' };
    }
    if (
      /(일정|약속|미팅|회의).*(만들|추가|등록|잡아)|(?:만들|추가|등록|잡아).*(일정|약속|미팅|회의)/
        .test(message)
    ) {
      return { kind: 'calendar_create' };
    }
    if (/(일정|약속|미팅|회의).*(수정|바꿔|변경)/.test(message)) {
      return { kind: 'calendar_update' };
    }
    if (/(일정|약속|미팅|회의).*(삭제|지워|취소)/.test(message)) {
      return { kind: 'calendar_delete' };
    }
  }
  if (
    /(일정|스케줄|약속|미팅|회의|캘린더)/.test(message)
    && /(오늘|내일|모레|이번\s*주|다음\s*주|이번\s*달|언제|몇\s*개|모두|전체)/.test(message)
  ) {
    return { kind: 'exact_schedule', range: exactRange(message, nowMs) };
  }
  if (/(위키|지식|자료|문서|기록에서)/.test(message)) {
    return { kind: 'knowledge' };
  }
  return { kind: 'conversation' };
}

function parseAutomationChange(messageValue) {
  const message = String(messageValue || '').trim();
  let operation = 'update';
  if (/(만들|생성|추가|등록)/.test(message)) operation = 'create';
  else if (/(일시\s*정지|중지|멈춰|비활성)/.test(message)) operation = 'pause';
  else if (/(재개|다시\s*활성|활성화)/.test(message)) operation = 'resume';
  else if (/(지금\s*)?실행|바로\s*돌려/.test(message)) operation = 'run';
  const cron = message.match(/\b(?:\*|[0-9,-/]+)(?:\s+(?:\*|[0-9,-/]+)){4}\b/)?.[0] || '';
  const targetName = message
    .replace(cron, ' ')
    .replace(/자동화를?|오토메이션을?|cron(?:\s*job)?을?/gi, ' ')
    .replace(/만들어?\s*줘|생성해?\s*줘|추가해?\s*줘|등록해?\s*줘/g, ' ')
    .replace(/수정해?\s*줘|변경해?\s*줘|바꿔\s*줘/g, ' ')
    .replace(/일시\s*정지해?\s*줘|중지해?\s*줘|멈춰\s*줘|비활성화해?\s*줘/g, ' ')
    .replace(/재개해?\s*줘|다시\s*활성화해?\s*줘|활성화해?\s*줘/g, ' ')
    .replace(/지금\s*실행해?\s*줘|바로\s*돌려\s*줘|실행해?\s*줘/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    operation,
    targetName: targetName || (operation === 'create' ? '새 자동화' : ''),
    input: {
      ...(operation === 'create' ? {
        name: targetName || '새 자동화',
        goal: message,
        schedule: cron,
        agentId: 'default',
      } : {}),
      ...(operation === 'update' && cron ? { schedule: cron } : {}),
    },
  };
}

function parseCalendarCreate(messageValue, nowMs = Date.now()) {
  const message = String(messageValue || '');
  const range = exactRange(message, nowMs);
  const hourMatch = message.match(/(오전|오후)?\s*(\d{1,2})(?::(\d{2}))?\s*시/);
  let hour = hourMatch ? Number(hourMatch[2]) : 9;
  if (hourMatch?.[1] === '오후' && hour < 12) hour += 12;
  if (hourMatch?.[1] === '오전' && hour === 12) hour = 0;
  const minute = hourMatch?.[3] ? Number(hourMatch[3]) : 0;
  const localDay = new Date(new Date(range.from).getTime() + SEOUL_OFFSET_MS);
  const startMs = Date.UTC(
    localDay.getUTCFullYear(),
    localDay.getUTCMonth(),
    localDay.getUTCDate(),
    hour,
    minute,
  ) - SEOUL_OFFSET_MS;
  const title = message
    .replace(/오늘|내일|모레|이번\s*주|다음\s*주/g, ' ')
    .replace(/(오전|오후)?\s*\d{1,2}(?::\d{2})?\s*시에?/g, ' ')
    .replace(/일정을?|일정|약속을?|약속|만들어\s*줘|만들어줘|추가해\s*줘|추가해줘|등록해\s*줘|등록해줘|잡아\s*줘|잡아줘/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '새 일정';
  return {
    title,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + 60 * 60 * 1000).toISOString(),
    timezone: 'Asia/Seoul',
  };
}

function parseDelegatedWork(messageValue) {
  const goal = String(messageValue || '')
    .replace(/에이전트에게|에이전트한테|위임해\s*줘|위임해줘|맡겨\s*줘|맡겨줘/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    goal: goal || '위임 작업',
    title: goal || '위임 작업',
    executionEngine: 'auto',
    agentId: 'default',
  };
}

module.exports = {
  classifyCalendarAiIntent,
  exactRange,
  parseAutomationChange,
  parseCalendarCreate,
  parseDelegatedWork,
};
