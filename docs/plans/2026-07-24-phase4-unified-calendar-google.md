# Plan: Phase 4 Unified Calendar + Google Connector

- Date: 2026-07-24
- Owner: Grok
- Work size: Large | Boundary
- Status: **Verified** (first root audit A–G + second root audit findings 1–11 closed)

## Goal

Workspace-owned Unified Calendar with honest coverage, real Google adapter (vault + fetch),
OAuth boundary separate from WorkOS, durable webhook reconcile, complete external mutations,
DST-aware singleEvents projections, encrypted credential vault, runtime-driven sync outbox,
and honest ETE/evidence.

## Non-Goals

- Full GPT Calendar AI (Phase 6)
- Live Google Cloud OAuth product proof (not exercised; production fails closed)
- Apple/Outlook connectors

## First root audit A–G + vault

| ID | Resolution |
|----|------------|
| A | Coverage containment + separate internal/agent_work; page limit 50 rejects |
| B | Real adapter vault+fetch; retry only 429/5xx |
| C | Workspace Google authorize/callback; body workspace ignored |
| D | Durable `calendar_sync_requests` before webhook 200; drain path |
| E | DELETE + If-Match + receipt fence; disconnect revoke/stop |
| F | `singleEvents=true`; NY DST wall-clock test |
| G | Honest RED baseline; ETE API asserts Google+Internal+Agent after restart |
| Vault | AES-256-GCM at rest; fail closed without `GOOGLE_CREDENTIAL_ENCRYPTION_KEY` or external vault; **app role has NO grants on `calendar_credential_vault`** |

## Second root audit findings 1–11

| # | Defect | Resolution |
|---|--------|------------|
| 1 | Sync outbox not runtime-driven | `UnifiedCalendar.startBackgroundWorkers/stopBackgroundWorkers`; wired in `createPhase1Runtime`; `UNIFIED_CALENDAR_BACKGROUND_WORKERS` / `CALENDAR_SYNC_BACKGROUND_WORKERS`; timers **unref**; drain + renewExpiringWatches |
| 2 | Drain claim race | Atomic `UPDATE…RETURNING` + `FOR UPDATE SKIP LOCKED`; `claimed_at` / `lease_expires_at`; stale running reclaim |
| 3 | Webhook idempotency | Key = `channelId:X-Goog-Message-Number`; unique partial index; ON CONFLICT do nothing |
| 4 | Watch renew gap | Create new channel → persist → stop old; stop failure leaves error (not silent stopped) |
| 5 | Mutation idempotency concurrency | `pg_advisory_xact_lock(workspace, key)` before provider; claim/reselect; readonly reject; non-conflict update fails receipt |
| 6 | Disconnect/revoke swallows errors | Provider fail keeps credential/watch; source `error` + typed `last_error`; real adapter bounded revoke retry before vault delete |
| 7 | ETag + singleEvents | Map HTTP **412** and **409** → `GOOGLE_ETAG_CONFLICT` (no retry); `singleEvents=true` on syncToken list |
| 8 | OAuth state + service tables | Finalize binds `workspace_id + state + user_id`; hostile same-workspace second owner; **REVOKE** app-role DML on oauth/sync/vault; service pool only (documented in 0021) |
| 9 | Coverage merge | Adjacent/overlapping complete intervals merge; split coverage RED → complete |
| 10 | Vault key strength | Fail closed unless exactly 32-byte base64 or 64 hex (no weak passphrases); AES-256-GCM |
| 11 | Deterministic create id | Adapter createEvent receives Google-compatible id derived from idempotency key (DB/advisory remain authority) |

## RED baseline (second root)

```
node --test apps/backend/tests/phase4-second-root-audit.test.cjs
# Before GREEN: behavioral slices for 1–11 written RED; implementation closed all 12
# Last residual RED during close: finding #8 app-role DML assert aborted txn after first denial
# (savepoint fix); grants already REVOKE'd in 0021
```

First root RED (historical): `phase4-root-audit.test.cjs` — 11 tests, pass 2, fail 9.

## Migrations

- `0019_unified_calendar_google.sql`
- `0020_unified_calendar_oauth_sync_outbox.sql` (vault, oauth states, sync outbox)
- `0021_unified_calendar_sync_lease_idempotency.sql` (lease columns, webhook idem key, **service-owned REVOKE** + docs)

## Duplicate external-create (manual QA / 05-backend-restart)

| Item | Detail |
|------|--------|
| Symptom | Day view after backend restart showed **two** identical `Google external create` at 10:00 |
| Root cause | ETE double-create: UI button (`Date.now()` key) **and** API create (second key) → two provider events; month view truncated to one pill |
| Projection harden | `canonicalOccurrenceKey` (ISO startsAt); create replaces per-`provider_event_id` occurrences; sync rebuild deletes + rebuilds with key dedupe |
| ETE | Single stable idempotency key; assert API/DB/day-leaf count **=== 1** after create+sync and both restarts |
| Backend test | third-root #4 create then sync → one occurrence |

## Final gates (latest close)

| Gate | Result |
|------|--------|
| phase4-*.test.cjs (all) | **33/33** |
| `backend:check` | pass |
| `test:backend` | **394/394** |
| desktop tests | **179/179** |
| runner tests | **17/17** |
| Playwright ETE | **pass** (`ok: true`; 05 shows single external create) |
| `git diff --check` | pass |
| Orphans | cleaned |
| Workers | timers unref; tests stop durableExecution **and** unifiedCalendar |

## Production requirements

- `GOOGLE_CREDENTIAL_ENCRYPTION_KEY` = 32-byte base64 **or** 64 hex (fail closed otherwise), **or** inject external vault with `GOOGLE_CREDENTIAL_VAULT=external`
- `GOOGLE_OAUTH_CLIENT_ID` / `SECRET` / `REDIRECT_URI` for real OAuth
- `GOOGLE_CALENDAR_WEBHOOK_URL` HTTPS for watches
- `UNIFIED_CALENDAR_BACKGROUND_WORKERS=1` (default) for outbox drain + watch renew; set `0` in tests
- `UNIFIED_CALENDAR_EXTERNAL_ENABLED=1` to enable Google product surface
- `AGENT_CALENDAR_FAKE_GOOGLE=1` only for tests/ETE

## Rollback

- `UNIFIED_CALENDAR_EXTERNAL_ENABLED=false`
- `UNIFIED_CALENDAR_BACKGROUND_WORKERS=0`
- Fake-connect only with `AGENT_CALENDAR_FAKE_GOOGLE=1`
