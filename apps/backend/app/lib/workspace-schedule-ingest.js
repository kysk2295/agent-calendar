'use strict';

const path = require('node:path');

const {
  buildScheduleIngestDrafts,
  detectConflicts,
} = require('./schedule-ingest');
const { assertWorkspaceScope } = require('./workspace-scope');

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.heic', '.heif', '.jpeg', '.jpg', '.png']);

function requestError(code, statusHint) {
  const error = new Error(code);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function parseContentDisposition(value = '') {
  const params = {};
  for (const part of String(value).split(';').slice(1)) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    let entry = part.slice(separator + 1).trim();
    if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
    params[key] = entry.replace(/\\"/g, '"');
  }
  return params;
}

function multipartBoundary(contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = String(match && (match[1] || match[2]) || '').trim();
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw requestError('INVALID_MULTIPART', 400);
  }
  return boundary;
}

function parseMultipartParts(buffer, contentType) {
  const boundary = multipartBoundary(contentType);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(delimiter);
  if (cursor < 0) throw requestError('INVALID_MULTIPART', 400);

  while (cursor >= 0) {
    const start = cursor + delimiter.length;
    if (buffer.subarray(start, start + 2).toString('ascii') === '--') break;
    const contentStart = buffer.subarray(start, start + 2).toString('ascii') === '\r\n'
      ? start + 2
      : start;
    const next = buffer.indexOf(delimiter, contentStart);
    if (next < 0) throw requestError('INVALID_MULTIPART', 400);
    let part = buffer.subarray(contentStart, next);
    if (part.subarray(-2).toString('ascii') === '\r\n') part = part.subarray(0, -2);
    const headersEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headersEnd < 0) throw requestError('INVALID_MULTIPART', 400);
    const rawHeaders = part.subarray(0, headersEnd).toString('utf8');
    const headers = {};
    for (const line of rawHeaders.split('\r\n')) {
      const separator = line.indexOf(':');
      if (separator < 1) throw requestError('INVALID_MULTIPART', 400);
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      headers[name] = value;
    }
    parts.push({ headers, body: part.subarray(headersEnd + 4) });
    cursor = next;
  }
  return parts;
}

function supportedImage(filename, contentType) {
  const normalizedType = String(contentType || '').toLowerCase().split(';')[0].trim();
  const extension = path.extname(String(filename || '')).toLowerCase();
  return SUPPORTED_IMAGE_TYPES.has(normalizedType)
    || ((!normalizedType || normalizedType === 'application/octet-stream')
      && SUPPORTED_IMAGE_EXTENSIONS.has(extension));
}

function parseMultipartScheduleIngest(buffer, contentType) {
  const fields = {};
  const imageFiles = [];
  for (const part of parseMultipartParts(buffer, contentType)) {
    const disposition = parseContentDisposition(part.headers['content-disposition']);
    const name = String(disposition.name || '').trim();
    if (!name) throw requestError('INVALID_MULTIPART', 400);
    if (disposition.filename !== undefined) {
      if (name !== 'image' && name !== 'file') {
        throw requestError('UNSUPPORTED_INGEST_MEDIA_TYPE', 415);
      }
      const filename = path.basename(String(disposition.filename || 'image'));
      const fileContentType = String(part.headers['content-type'] || '').toLowerCase();
      if (!supportedImage(filename, fileContentType)) {
        throw requestError('UNSUPPORTED_INGEST_MEDIA_TYPE', 415);
      }
      imageFiles.push({
        filename,
        contentType: fileContentType || 'application/octet-stream',
        buffer: Buffer.from(part.body),
      });
      continue;
    }
    if (name === 'text' || name === 'message' || name === 'query') {
      fields[name] = part.body.toString('utf8');
    }
  }
  if (imageFiles.length > 1) throw requestError('TOO_MANY_INGEST_IMAGES', 400);
  return {
    textInput: String(fields.text || fields.message || fields.query || '').trim(),
    imageFile: imageFiles[0] || null,
  };
}

function parseScheduleIngestRequest({ buffer = Buffer.alloc(0), contentType = '' } = {}) {
  const rawType = String(contentType || '').toLowerCase();
  if (/^multipart\/form-data\b/.test(rawType)) {
    return parseMultipartScheduleIngest(Buffer.from(buffer), contentType);
  }
  if (/^text\/plain\b/.test(rawType)) {
    return { textInput: Buffer.from(buffer).toString('utf8').trim(), imageFile: null };
  }
  if (!rawType || /^application\/json\b/.test(rawType)) {
    let body = {};
    try {
      body = buffer.length ? JSON.parse(Buffer.from(buffer).toString('utf8')) : {};
    } catch {
      throw requestError('INVALID_JSON', 400);
    }
    return {
      textInput: String(body.text || body.message || body.query || '').trim(),
      imageFile: null,
    };
  }
  throw requestError('UNSUPPORTED_INGEST_MEDIA_TYPE', 415);
}

function addUtcDays(dateKey, days) {
  const timestamp = Date.parse(`${dateKey}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString();
}

function draftRange(drafts) {
  const dates = drafts
    .map((draft) => String(draft.date || ''))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  if (!dates.length) return null;
  return {
    from: addUtcDays(dates[0], -1),
    to: addUtcDays(dates[dates.length - 1], 2),
  };
}

function instantParts(value, timezone = 'UTC') {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return null;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function conflictCalendarItem(entry) {
  const timezone = String(entry.timezone || 'UTC');
  const start = instantParts(entry.startsAt || entry.start || entry.starts_at, timezone);
  const end = instantParts(entry.endsAt || entry.end || entry.ends_at, timezone);
  return {
    id: entry.id || entry.entryId,
    title: entry.title,
    date: start && start.date,
    time: start && start.time,
    endTime: end && end.time,
  };
}

async function workspaceCalendarState(scope, runtime, range) {
  const internalEvents = runtime.product && typeof runtime.product.listCalendarEvents === 'function'
    ? await runtime.product.listCalendarEvents(scope, range)
    : [];
  if (runtime.unifiedCalendar && typeof runtime.unifiedCalendar.queryRange === 'function') {
    const unified = await runtime.unifiedCalendar.queryRange(scope, range);
    const externalEvents = Array.isArray(unified.entries)
      ? unified.entries
        .filter((entry) => entry.sourceKind === 'external_calendar')
        .map(conflictCalendarItem)
      : [];
    const humanScheduleEvents = [...internalEvents, ...externalEvents];
    return {
      events: humanScheduleEvents,
      coverage: Array.isArray(unified.coverage) ? unified.coverage : [],
    };
  }
  return { events: internalEvents, coverage: [] };
}

async function buildWorkspaceScheduleIngestDrafts({
  scope,
  request,
  runtime,
  env = process.env,
} = {}) {
  assertWorkspaceScope(scope);
  if (!runtime || !runtime.product) throw requestError('SCHEDULE_INGEST_UNAVAILABLE', 503);
  const result = await buildScheduleIngestDrafts({
    textInput: request && request.textInput,
    imageFile: request && request.imageFile,
    state: { events: [] },
    env,
    ...(typeof runtime.scheduleIngestCompletion === 'function'
      ? { completionImpl: runtime.scheduleIngestCompletion }
      : {}),
    ...(typeof runtime.scheduleIngestFetch === 'function'
      ? { fetchImpl: runtime.scheduleIngestFetch }
      : {}),
    ...(typeof runtime.scheduleIngestOcr === 'function'
      ? { ocrRunner: runtime.scheduleIngestOcr }
      : {}),
  });
  const range = draftRange(result.drafts || []);
  let conflicts = [];
  let coverage = [];
  let conflictCheckComplete = true;
  const warnings = [...(result.warnings || [])];
  if (range) {
    try {
      const state = await workspaceCalendarState(scope, runtime, range);
      conflicts = detectConflicts(result.drafts, state);
      coverage = state.coverage;
    } catch {
      conflictCheckComplete = false;
      warnings.push('현재 일정과의 충돌을 확인하지 못했습니다. 등록 전에 캘린더를 확인해 주세요.');
    }
  }
  return {
    ...result,
    warnings,
    conflicts,
    workspaceId: scope.workspaceId,
    conflictCheck: {
      complete: conflictCheckComplete,
      range,
      coverage,
    },
  };
}

module.exports = {
  buildWorkspaceScheduleIngestDrafts,
  conflictCalendarItem,
  draftRange,
  parseScheduleIngestRequest,
};
