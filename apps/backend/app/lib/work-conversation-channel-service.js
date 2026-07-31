'use strict';

const crypto = require('node:crypto');
const {
  projectPublicDisplayEvent,
  publicDisplayDelivery,
} = require('./public-work-conversation-event');
const { resolveWorkspaceScope } = require('./workspace-scope');
const { WorkspaceScopedProductService } = require('./workspace-scoped-product-service');

function reject(code, message, statusHint = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.statusHint = statusHint;
  throw error;
}

function publicId(value, field, maximum = 160) {
  const result = String(value || '').trim();
  if (!result || result.length > maximum || !/^[A-Za-z][A-Za-z0-9_-]+$/.test(result)) {
    reject(`${field.toUpperCase()}_INVALID`, `${field} is invalid`, 400);
  }
  return result;
}

function publicModel(value) {
  const model = String(value || '').trim();
  if (!model) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
    || /^(sk-|bearer|token|cookie|secret)/i.test(model)) {
    reject('INVALID_EXECUTION_MODEL', 'execution model identifier is invalid', 422);
  }
  return model;
}

function reportedIngressOwnership(value) {
  const ownership = String(value || '').trim().toLowerCase();
  if (!['owned', 'conflict'].includes(ownership)) {
    reject(
      'CHANNEL_INGRESS_OWNERSHIP_INVALID',
      'channel ingress ownership is invalid',
      400,
    );
  }
  return ownership;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

class WorkConversationChannelService {
  constructor({ pool } = {}) {
    if (!pool) throw new Error('WorkConversationChannelService requires pool');
    this.pool = pool;
    this.product = new WorkspaceScopedProductService({ pool });
  }

  async bind(runner, input = {}) {
    const workConversationId = publicId(input.workConversationId, 'work_conversation_id');
    const bindingHandle = publicId(input.bindingHandle, 'binding_handle');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const session = await client.query(
        `select id
         from agent_sessions
         where workspace_id = $1 and id = $2
         limit 1`,
        [runner.workspace_id, workConversationId],
      );
      if (!session.rowCount) reject('CHANNEL_CONVERSATION_NOT_FOUND', 'conversation not found', 404);
      const existing = await client.query(
        `select *
         from work_conversation_channel_endpoints
         where workspace_id = $1 and runner_id = $2
           and channel = 'telegram' and binding_handle = $3
         limit 1`,
        [runner.workspace_id, runner.id, bindingHandle],
      );
      let endpoint = existing.rows[0];
      if (endpoint && endpoint.work_conversation_id !== workConversationId) {
        reject('CHANNEL_BINDING_CONFLICT', 'binding already belongs to another conversation', 409);
      }
      if (!endpoint) {
        const inserted = await client.query(
          `insert into work_conversation_channel_endpoints (
             id, workspace_id, work_conversation_id, runner_id, channel,
             binding_handle, status, outbound_cursor, public_metadata, last_activity_at
           ) values (
             $1,$2,$3,$4,'telegram',$5,'active',
             (
               select coalesce(max(sequence), 0)
               from agent_session_events
               where workspace_id = $2 and session_id = $3
             ),
             '{}'::jsonb,now()
           )
           returning *`,
          [newId('channel'), runner.workspace_id, workConversationId, runner.id, bindingHandle],
        );
        endpoint = inserted.rows[0];
      }
      await client.query('commit');
      return {
        ok: true,
        endpoint: {
          id: endpoint.id,
          workConversationId: endpoint.work_conversation_id,
          channel: endpoint.channel,
          status: endpoint.status,
        },
      };
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async #endpoint(runner, endpointId, queryable = this.pool, { lock = false } = {}) {
    const id = publicId(endpointId, 'endpoint_id');
    const result = await queryable.query(
      `select e.*, s.mission_id
       from work_conversation_channel_endpoints e
       inner join agent_sessions s
         on s.workspace_id = e.workspace_id and s.id = e.work_conversation_id
       where e.workspace_id = $1 and e.runner_id = $2 and e.id = $3
         and e.channel = 'telegram' and e.status = 'active'
       limit 1
       ${lock ? 'for update of e' : ''}`,
      [runner.workspace_id, runner.id, id],
    );
    if (!result.rowCount) reject('CHANNEL_ENDPOINT_NOT_FOUND', 'channel endpoint not found', 404);
    return result.rows[0];
  }

  async #ownerScope(workspaceId) {
    const membership = await this.pool.query(
      `select user_id
       from workspace_memberships
       where workspace_id = $1 and status = 'active'
       order by case when role = 'owner' then 0 else 1 end, created_at asc
       limit 1`,
      [workspaceId],
    );
    if (!membership.rowCount) reject('CHANNEL_WORKSPACE_OWNER_NOT_FOUND', 'workspace member not found', 409);
    return resolveWorkspaceScope(this.pool, {
      userId: membership.rows[0].user_id,
      workspaceId,
    });
  }

  async reportIngressOwnership(runner, input = {}) {
    const endpoint = await this.#endpoint(runner, input.endpointId);
    const ingressOwnership = reportedIngressOwnership(input.ingressOwnership);
    const updated = await this.pool.query(
      `update work_conversation_channel_endpoints
       set public_metadata = public_metadata || jsonb_build_object(
             'ingressOwnership', $3::text,
             'ingressCheckedAt', now()
           ),
           last_activity_at = now(),
           updated_at = now()
       where workspace_id = $1 and id = $2
       returning public_metadata->>'ingressCheckedAt' as ingress_checked_at`,
      [runner.workspace_id, endpoint.id, ingressOwnership],
    );
    return {
      ok: true,
      ingressOwnership,
      ingressCheckedAt: new Date(updated.rows[0].ingress_checked_at).toISOString(),
    };
  }

  async inbound(runner, input = {}) {
    const endpoint = await this.#endpoint(runner, input.endpointId);
    const deliveryKey = publicId(input.deliveryKey, 'delivery_key', 200);
    const text = String(input.text || '').trim().slice(0, 4_000);
    if (!text) reject('CHANNEL_TEXT_REQUIRED', 'channel text is required', 422);
    const receiptId = newId('receipt');
    const claimed = await this.pool.query(
      `insert into work_conversation_channel_receipts (
         id, workspace_id, endpoint_id, direction, delivery_key, status
       ) values ($1,$2,$3,'inbound',$4,'pending')
       on conflict (workspace_id, endpoint_id, direction, delivery_key)
       do update set status = 'pending', updated_at = now()
       where work_conversation_channel_receipts.status = 'failed'
          or (
            work_conversation_channel_receipts.status = 'pending'
            and work_conversation_channel_receipts.updated_at < now() - interval '1 minute'
          )
       returning id`,
      [receiptId, runner.workspace_id, endpoint.id, deliveryKey],
    );
    if (!claimed.rowCount) {
      const receipt = await this.pool.query(
        `select event_id, status
         from work_conversation_channel_receipts
         where workspace_id = $1 and endpoint_id = $2
           and direction = 'inbound' and delivery_key = $3
         limit 1`,
        [runner.workspace_id, endpoint.id, deliveryKey],
      );
      if (receipt.rows[0]?.status === 'delivered') {
        return { ok: true, idempotentReplay: true, eventId: receipt.rows[0].event_id };
      }
      reject('CHANNEL_DELIVERY_IN_PROGRESS', 'channel delivery is already in progress', 409);
    }
    try {
      const scope = await this.#ownerScope(runner.workspace_id);
      const result = await this.product.addAgentWorkMessage(scope, endpoint.mission_id, {
        clientMessageId: `channel:${endpoint.id}:${deliveryKey}`,
        text,
        executionEngine: input.executionEngine,
        requestedModel: publicModel(input.requestedModel),
        origin: 'telegram',
        originEndpointId: endpoint.id,
      });
      const eventId = String(result?.event?.id || '');
      await this.pool.query(
        `update work_conversation_channel_receipts
         set event_id = $4, status = 'delivered', updated_at = now()
         where workspace_id = $1 and endpoint_id = $2
           and direction = 'inbound' and delivery_key = $3`,
        [runner.workspace_id, endpoint.id, deliveryKey, eventId],
      );
      await this.pool.query(
        `update work_conversation_channel_endpoints
         set inbound_cursor = $3, last_activity_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2`,
        [runner.workspace_id, endpoint.id, deliveryKey],
      );
      return { ok: true, idempotentReplay: false, eventId };
    } catch (error) {
      await this.pool.query(
        `update work_conversation_channel_receipts
         set status = 'failed', updated_at = now()
         where workspace_id = $1 and endpoint_id = $2
           and direction = 'inbound' and delivery_key = $3`,
        [runner.workspace_id, endpoint.id, deliveryKey],
      ).catch(() => {});
      throw error;
    }
  }

  async nextOutbound(runner, input = {}) {
    const requestedReceiptId = input.receiptId
      ? publicId(input.receiptId, 'receipt_id')
      : '';
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const endpoint = await this.#endpoint(runner, input.endpointId, client, { lock: true });
      const active = await client.query(
        `select *
         from work_conversation_channel_receipts
         where workspace_id = $1 and endpoint_id = $2 and direction = 'outbound'
           and status in ('claimed', 'sending')
         order by sequence asc
         limit 1
         for update`,
        [runner.workspace_id, endpoint.id],
      );
      if (active.rowCount && active.rows[0].status === 'sending') {
        const receipt = active.rows[0];
        await client.query(
          `update work_conversation_channel_receipts
           set status = 'delivery_unknown', terminal_at = now(), updated_at = now()
           where workspace_id = $1 and endpoint_id = $2 and id = $3`,
          [runner.workspace_id, endpoint.id, receipt.id],
        );
        await client.query(
          `update work_conversation_channel_endpoints
           set outbound_cursor = greatest(outbound_cursor, $3),
               public_metadata = public_metadata || jsonb_build_object(
                 'outboundDeliveryStatus', 'delivery_unknown',
                 'outboundDeliverySequence', $3::bigint
               ),
               last_activity_at = now(), updated_at = now()
           where workspace_id = $1 and id = $2`,
          [runner.workspace_id, endpoint.id, Number(receipt.sequence)],
        );
        await client.query('commit');
        return {
          ok: true,
          delivery: null,
          deliveryUnknown: {
            receiptId: receipt.id,
            eventId: receipt.event_id,
            sequence: Number(receipt.sequence),
            status: 'delivery_unknown',
          },
        };
      }

      let receipt = active.rows[0] || null;
      if (receipt) {
        const claimMatches = requestedReceiptId && receipt.id === requestedReceiptId;
        const claimStale = new Date(receipt.updated_at).getTime() < Date.now() - 60_000;
        if (!claimMatches && !claimStale) {
          reject('CHANNEL_DELIVERY_IN_PROGRESS', 'channel delivery is already in progress', 409);
        }
        if (!claimMatches) {
          const reclaimed = await client.query(
            `update work_conversation_channel_receipts
             set claimed_at = now(), updated_at = now()
             where workspace_id = $1 and endpoint_id = $2 and id = $3
             returning *`,
            [runner.workspace_id, endpoint.id, receipt.id],
          );
          receipt = reclaimed.rows[0];
        }
      } else {
        if (requestedReceiptId) {
          reject('CHANNEL_DELIVERY_NOT_FOUND', 'channel delivery not found', 404);
        }
        const events = await client.query(
          `select id, sequence, kind, payload, created_at
           from agent_session_events
           where workspace_id = $1 and session_id = $2 and sequence > $3
             and coalesce(payload->>'originEndpointId', '') <> $4
           order by sequence asc
           limit 200`,
          [
            runner.workspace_id,
            endpoint.work_conversation_id,
            Number(endpoint.outbound_cursor || 0),
            endpoint.id,
          ],
        );
        const event = events.rows
          .map((row) => projectPublicDisplayEvent(row, {
            sessionId: endpoint.work_conversation_id,
          }))
          .find(Boolean);
        if (!event) {
          await client.query('commit');
          return { ok: true, delivery: null };
        }
        const inserted = await client.query(
          `insert into work_conversation_channel_receipts (
             id, workspace_id, endpoint_id, direction, delivery_key,
             event_id, sequence, status, claimed_at
           ) values ($1,$2,$3,'outbound',$4,$4,$5,'claimed',now())
           returning *`,
          [
            newId('receipt'),
            runner.workspace_id,
            endpoint.id,
            event.id,
            event.sequence,
          ],
        );
        receipt = inserted.rows[0];
      }

      const eventResult = await client.query(
        `select id, sequence, kind, payload, created_at
         from agent_session_events
         where workspace_id = $1 and session_id = $2
           and id = $3 and sequence = $4
         limit 1`,
        [
          runner.workspace_id,
          endpoint.work_conversation_id,
          receipt.event_id,
          receipt.sequence,
        ],
      );
      const event = eventResult.rowCount
        ? projectPublicDisplayEvent(eventResult.rows[0], {
          sessionId: endpoint.work_conversation_id,
        })
        : null;
      if (!event) reject('CHANNEL_DELIVERY_NOT_FOUND', 'channel delivery not found', 404);
      await client.query('commit');
      return {
        ok: true,
        delivery: {
          ...publicDisplayDelivery(event),
          receiptId: receipt.id,
          status: 'claimed',
        },
      };
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async beginOutbound(runner, input = {}) {
    const receiptId = publicId(input.receiptId, 'receipt_id');
    const eventId = publicId(input.eventId, 'event_id');
    const sequence = Number(input.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      reject('CHANNEL_SEQUENCE_INVALID', 'sequence is invalid', 400);
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const endpoint = await this.#endpoint(runner, input.endpointId, client, { lock: true });
      const receipt = await client.query(
        `select status
         from work_conversation_channel_receipts
         where workspace_id = $1 and endpoint_id = $2 and id = $3
           and direction = 'outbound' and event_id = $4 and sequence = $5
         limit 1
         for update`,
        [runner.workspace_id, endpoint.id, receiptId, eventId, sequence],
      );
      if (!receipt.rowCount) reject('CHANNEL_DELIVERY_NOT_FOUND', 'channel delivery not found', 404);
      if (receipt.rows[0].status === 'sending') {
        await client.query('commit');
        return { ok: true, receiptId, eventId, sequence, status: 'sending' };
      }
      if (receipt.rows[0].status !== 'claimed') {
        reject('CHANNEL_DELIVERY_NOT_OPEN', 'channel delivery is not open', 409);
      }
      await client.query(
        `update work_conversation_channel_receipts
         set status = 'sending', send_started_at = now(), updated_at = now()
         where workspace_id = $1 and endpoint_id = $2 and id = $3`,
        [runner.workspace_id, endpoint.id, receiptId],
      );
      await client.query('commit');
      return { ok: true, receiptId, eventId, sequence, status: 'sending' };
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async ackOutbound(runner, input = {}) {
    const receiptId = publicId(input.receiptId, 'receipt_id');
    const eventId = publicId(input.eventId, 'event_id');
    const sequence = Number(input.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      reject('CHANNEL_SEQUENCE_INVALID', 'sequence is invalid', 400);
    }
    const outcome = String(input.outcome || 'delivered');
    if (!['delivered', 'delivery_unknown'].includes(outcome)) {
      reject('CHANNEL_DELIVERY_OUTCOME_INVALID', 'channel delivery outcome is invalid', 400);
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const endpoint = await this.#endpoint(runner, input.endpointId, client, { lock: true });
      const receipt = await client.query(
        `select status
         from work_conversation_channel_receipts
         where workspace_id = $1 and endpoint_id = $2 and id = $3
           and direction = 'outbound' and event_id = $4 and sequence = $5
         limit 1
         for update`,
        [runner.workspace_id, endpoint.id, receiptId, eventId, sequence],
      );
      if (!receipt.rowCount) reject('CHANNEL_DELIVERY_NOT_FOUND', 'channel delivery not found', 404);
      if (receipt.rows[0].status === outcome) {
        await client.query('commit');
        return { ok: true, receiptId, eventId, sequence, status: outcome };
      }
      if (receipt.rows[0].status !== 'sending') {
        reject('CHANNEL_DELIVERY_NOT_OPEN', 'channel delivery is not open', 409);
      }
      await client.query(
        `update work_conversation_channel_receipts
         set status = $4, terminal_at = now(), updated_at = now()
         where workspace_id = $1 and endpoint_id = $2 and id = $3`,
        [runner.workspace_id, endpoint.id, receiptId, outcome],
      );
      await client.query(
        `update work_conversation_channel_endpoints
         set outbound_cursor = greatest(outbound_cursor, $3),
             public_metadata = public_metadata || jsonb_build_object(
               'outboundDeliveryStatus', $4::text,
               'outboundDeliverySequence', $3::bigint
             ),
             last_activity_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2`,
        [runner.workspace_id, endpoint.id, sequence, outcome],
      );
      await client.query('commit');
      return { ok: true, receiptId, eventId, sequence, status: outcome };
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  WorkConversationChannelService,
};
