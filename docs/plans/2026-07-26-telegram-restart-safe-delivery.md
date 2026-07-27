# Telegram restart-safe delivery

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

Make Runner-local Telegram ingress and egress survive Gateway and Runner process
recreation without duplicating canonical inbound events or automatically resending
an outbound message whose Telegram delivery may already have occurred.

## Non-Goals

- Do not change exact active provider endpoint routing or the credential-free
  public-display tuple frozen by production-readiness Todo 7.
- Do not claim exactly-once Telegram delivery.
- Do not mutate a real bot, token, chat, deployment, or production poller.
- Do not change Desktop UI, CI, grants, or release machinery.

## Work Size

Large / Boundary: this changes persisted receipt meaning and the signed
Runner-to-Gateway channel protocol.

## Touched Boundaries

- Backend gateway: signed Telegram claim/begin/ack routes.
- Backend library: inbound receipt arbitration and durable outbound ledger.
- DB/migrations: outbound receipt lifecycle and claim timestamps.
- Runner: durable per-update offsets, outbound local ledger, per-binding process
  lock, and kill switch.
- Tests: Backend PostgreSQL concurrency/restart and Runner process-recreation
  fixtures.
- Docs: this implementation plan and bounded evidence only.

## Success Criteria

- [x] Simultaneous duplicate inbound creates one canonical event; fresh pending
  returns scoped 409; delivered replays; failed and stale pending retry.
- [x] Outbound is durably claimed before send and only the matching endpoint,
  event, sequence, and receipt may begin or acknowledge it.
- [x] Cursor and acknowledgement are monotonic and duplicate acknowledgement is
  idempotent.
- [x] A restart after send begins records one terminal `delivery_unknown`,
  advances past that event, and never automatically resends it.
- [x] Telegram update offsets persist after each accepted/skipped update and
  survive Runner process recreation.
- [x] One process loop owns each local binding; stale process locks recover; the
  kill switch performs no Bot API or Gateway channel calls.
- [x] Bot token and chat id remain absent from Gateway persistence, responses,
  errors, logs, and evidence.

## Edge Cases

- Concurrent `next`: exactly one claim wins; the loser receives opaque 409 and
  cannot move the cursor.
- Crash after claim but before send: the persisted local receipt resumes the
  same server claim.
- Crash after begin, during send, or after Telegram acceptance but before ack:
  the receipt becomes `delivery_unknown` and is never selected again.
- Telegram 409: ingress ownership reports conflict while update and outbound
  cursors remain unchanged.
- Foreign, wrong endpoint/event/sequence/receipt: fail closed without revealing
  whether another Workspace owns the referenced row.

## Test Plan

Product tests precede implementation.

- RED:
  - [x] Backend receipt concurrency, stale retry, claim/begin/ack, hostile IDs,
    restart, and monotonic cursor tests fail for the missing lifecycle.
  - [x] Runner process fixture fails for per-update persistence, send-start
    uncertainty, duplicate loop prevention, and kill switch.
- GREEN:
  - [x] Add the smallest schema, service, route, store, and Runner loop changes.
- REFACTOR:
  - [x] Keep Telegram lifecycle helpers local and preserve Todo 7 projection.

## Acceptance Gates

- [x] Focused Backend Telegram restart test.
- [x] Focused Runner Telegram restart/process test.
- [x] `npm run backend:check`
- [x] `npm run runner:check`
- [x] `npm run test:backend`
- [x] `npm run test:runner`
- [x] `npm test`

## Step-by-Step Checklist

- [x] Pin current Todo 7 public projection and active routing.
- [x] Capture RED Backend receipt/claim boundary evidence.
- [x] Implement migration and Gateway lifecycle.
- [x] Capture RED Runner restart/lock/kill-switch evidence.
- [x] Implement Runner durable ledger, offsets, lock, and kill switch.
- [x] Run focused then full gates and record redacted evidence/cleanup.

## Rollback / Fallback

Set `AGENT_CALENDAR_TELEGRAM_ENABLED=0` on the Runner to stop all channel
polling and delivery immediately. Existing canonical history, channel endpoint,
receipts, and provider sessions remain intact. Rolling back application code
does not delete the additive migration; older code can continue reading
`delivered` receipts but must remain kill-switched until upgraded again.

## Remaining Risks

- Telegram cannot provide an atomic send-and-ack transaction. Therefore
  send-start crashes intentionally trade possible non-delivery for no automatic
  duplicate and expose `delivery_unknown`.
