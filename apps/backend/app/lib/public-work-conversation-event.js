'use strict';

const { publicSessionEventRecord } = require('./public-agent-records');

const DIRECT_PUBLIC_KINDS = new Set([
  'user_message',
  'approval_request',
  'approval_response',
  'error',
  'blocked',
  'revision_completed',
]);
const NON_FINAL_PHASES = new Set([
  'accepted',
  'leased',
  'plan',
  'progress',
  'retry',
  'tool',
]);
const PUBLIC_ORIGINS = new Set([
  'agent',
  'calendar',
  'desktop',
  'execution',
  'telegram',
  'user',
]);
const GENERIC_COMPLETION = /^(?:Codex|Claude|Grok|Hermes) execution completed$/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function publicOrigin(kind, value) {
  const origin = String(value || '').trim().toLowerCase();
  if (PUBLIC_ORIGINS.has(origin)) return origin;
  return kind === 'user_message' || kind === 'approval_response' ? 'user' : 'agent';
}

function isPublicDisplayEvent(kind, payload) {
  if (DIRECT_PUBLIC_KINDS.has(kind)) return true;
  const metadata = asObject(payload.metadata);
  const phase = String(payload.phase || metadata.phase || '').trim().toLowerCase();
  if (kind === 'agent_message') {
    if (NON_FINAL_PHASES.has(phase)) return false;
    return !metadata.jobId
      || metadata.source === 'live_work_turn'
      || ['completed', 'result'].includes(phase);
  }
  if (kind === 'completion') {
    return !GENERIC_COMPLETION.test(String(payload.text || '').trim());
  }
  return false;
}

function preservePublicExecutionMetadata(projected, value) {
  const source = asObject(value);
  const metadata = { ...asObject(projected.metadata) };
  for (const key of ['jobId', 'providerSessionId']) {
    const identifier = String(source[key] || '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(identifier)) {
      metadata[key] = identifier;
    }
  }
  for (const key of ['requestedExecutionModel', 'resolvedExecutionModel']) {
    const model = String(source[key] || '').trim();
    if (
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
      && !/^(?:sk-|bearer|token|cookie|secret)/i.test(model)
    ) {
      metadata[key] = model;
    }
  }
  for (const key of ['turnIndex', 'turnTargetIndex']) {
    const number = Number(source[key]);
    if (Number.isFinite(number)) metadata[key] = number;
  }
  if (['single', 'comparison'].includes(source.turnMode)) {
    metadata.turnMode = source.turnMode;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function projectPublicDisplayEvent(row = {}, {
  sessionId = '',
  fallbackCreatedAt = '',
} = {}) {
  const kind = String(row.kind || '').trim().toLowerCase();
  const payload = asObject(row.payload);
  if (!isPublicDisplayEvent(kind, payload)) return null;
  const projected = publicSessionEventRecord({
    id: row.id,
    sessionId: row.session_id || sessionId,
    sequence: Number(row.sequence),
    kind,
    text: payload.text,
    createdAt: payload.createdAt
      || (row.created_at && new Date(row.created_at).toISOString())
      || fallbackCreatedAt,
    metadata: asObject(payload.metadata),
  });
  if (!projected?.id || !projected.text) return null;
  const metadata = preservePublicExecutionMetadata(projected, payload.metadata);
  return {
    ...projected,
    ...(metadata ? { metadata } : {}),
    origin: publicOrigin(kind, payload.origin),
  };
}

function publicDisplayTuple(event = {}) {
  return [
    Number(event.sequence),
    String(event.kind || ''),
    String(event.text || ''),
    String(event.origin || ''),
  ];
}

function publicDisplayDelivery(event = {}) {
  return {
    eventId: event.id,
    sequence: event.sequence,
    kind: event.kind,
    text: event.text,
    origin: event.origin,
    createdAt: event.createdAt,
  };
}

module.exports = {
  projectPublicDisplayEvent,
  publicDisplayDelivery,
  publicDisplayTuple,
};
