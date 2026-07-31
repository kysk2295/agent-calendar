'use strict';

/**
 * Phase 2 RunnerControl — enrollment, pending device, credentials, sessions.
 * Never stores plaintext challenge, claim token, or device credential.
 * Workspace authority always comes from server-issued WorkspaceScope.
 */

const crypto = require('node:crypto');
const { assertWorkspaceScope } = require('./workspace-scope');
const {
  engineAuthStatus,
  engineAuthenticationVerified,
  engineCapabilityReady,
  engineReportsAvailability,
} = require('./engine-capability-auth');
const { isFakeEngineAllowed } = require('./execution-engine-policy');
const { normalizeRunnerCapabilityCatalog } = require('./workspace-agent-directory');
const {
  runnerReleaseConfigurationFromEnv,
  verifyTrustedRunnerRelease,
} = require('./runner-release-trust');

const PROTOCOL_VERSION = 1;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CLAIM_TTL_MS = 15 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 90 * 1000;
const CLOCK_SKEW_MS = 120 * 1000;
const HUMAN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const BANNED_LAUNCH_ARGS = Object.freeze([
  '--yolo',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--full-auto',
  '--approval-mode=yolo',
]);

function reject(code, message, statusHint = 401) {
  const error = new Error(message || code);
  error.code = code;
  error.statusHint = statusHint;
  throw error;
}

function normalizeRunnerCapabilities(engines, env) {
  if (engines.fake && !isFakeEngineAllowed(env)) {
    reject('FAKE_ENGINE_FORBIDDEN', 'Fake Engine is allowed only in explicit tests', 422);
  }
  return {
    codex: normalizeEngine(engines.codex),
    claude: normalizeEngine(engines.claude),
    grok: normalizeEngine(engines.grok),
    hermes: normalizeEngine(engines.hermes),
    ...(engines.fake ? { fake: normalizeEngine(engines.fake) } : {}),
  };
}

function unavailableRunnerRelease(platform, notes = 'Signed Runner installer is unavailable.') {
  return {
    status: 'unavailable',
    version: null,
    platform,
    downloadUrl: null,
    manifestUrl: null,
    sha256: null,
    signature: null,
    publicKeyId: null,
    notes,
    verification: null,
  };
}

function normalizeRunnerReleaseManifest(value, requestedPlatform = 'darwin-arm64', options = {}) {
  const platform = String(requestedPlatform || 'darwin-arm64');
  try {
    return verifyTrustedRunnerRelease({
      release: value,
      requestedPlatform: platform,
      trustedPublicKeys: options.trustedPublicKeys,
      minimumVersion: options.minimumVersion,
      now: options.now,
      maxManifestAgeMs: options.maxManifestAgeMs,
    });
  } catch {
    return unavailableRunnerRelease(platform, 'Runner release metadata failed verification.');
  }
}

function hashOpaque(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function newOpaque(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function generateHumanCode() {
  const parts = [];
  for (let g = 0; g < 3; g += 1) {
    let chunk = '';
    for (let i = 0; i < 4; i += 1) {
      chunk += HUMAN_CODE_ALPHABET[crypto.randomInt(HUMAN_CODE_ALPHABET.length)];
    }
    parts.push(chunk);
  }
  return parts.join('-');
}

function fingerprintFromPublicKey(publicKeyB64) {
  return crypto.createHash('sha256').update(String(publicKeyB64 || ''), 'utf8').digest('hex');
}

function formatFingerprintGrouped(hex) {
  const clean = String(hex || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  const groups = [];
  for (let i = 0; i < clean.length; i += 4) {
    groups.push(clean.slice(i, i + 4));
  }
  return groups.join(' ');
}

function canonicalEnrollTranscript({
  challengeId,
  challengeCode,
  devicePublicKey,
  protocolVersion,
  hostName,
  hostOs,
  runnerVersion,
}) {
  return [
    'enroll-v1',
    `challengeId=${challengeId}`,
    `challengeCode=${challengeCode}`,
    `devicePublicKey=${devicePublicKey}`,
    `protocolVersion=${protocolVersion}`,
    `hostName=${hostName || ''}`,
    `hostOs=${hostOs || ''}`,
    `runnerVersion=${runnerVersion || ''}`,
  ].join('\n');
}

function canonicalDeviceTranscript({
  method,
  path,
  bodyHash,
  timestampMs,
  nonce,
  runnerId,
  sessionId,
  cursor,
}) {
  return [
    'device-v1',
    String(method || '').toUpperCase(),
    String(path || ''),
    String(bodyHash || ''),
    String(timestampMs || ''),
    String(nonce || ''),
    String(runnerId || ''),
    String(sessionId || ''),
    String(cursor == null ? '' : cursor),
  ].join('\n');
}

function bodySha256(body) {
  const raw = body == null || body === ''
    ? ''
    : typeof body === 'string'
      ? body
      : JSON.stringify(body);
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function verifyEd25519(publicKeyB64, message, signatureB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(String(publicKeyB64), 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(String(message), 'utf8'),
      key,
      Buffer.from(String(signatureB64), 'base64url'),
    );
  } catch {
    return false;
  }
}

function generateEd25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

function signEd25519(privateKeyB64, message) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(String(privateKeyB64), 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, Buffer.from(String(message), 'utf8'), key).toString('base64url');
}

async function withTransaction(pool, fn) {
  if (!pool || typeof pool.connect !== 'function') {
    if (pool && typeof pool.query === 'function') {
      await pool.query('begin');
      try {
        const result = await fn(pool);
        await pool.query('commit');
        return result;
      } catch (error) {
        try { await pool.query('rollback'); } catch { /* ignore */ }
        throw error;
      }
    }
    reject('RUNNER_POOL_REQUIRED', 'transaction requires a Pool', 503);
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try { await client.query('rollback'); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

async function writeAudit(client, {
  workspaceId,
  actorUserId = null,
  action,
  resourceType,
  resourceId,
  payload = {},
}) {
  await client.query(
    `insert into audit_events (id, workspace_id, actor_user_id, action, resource_type, resource_id, payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      newId('audit'),
      workspaceId,
      actorUserId,
      action,
      resourceType,
      resourceId || '',
      JSON.stringify(payload || {}),
    ],
  );
}

async function writeConnectionEvent(client, {
  workspaceId,
  runnerId = null,
  actorUserId = null,
  eventType,
  payload = {},
}) {
  await client.query(
    `insert into runner_connection_events (id, workspace_id, runner_id, actor_user_id, event_type, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      newId('rce'),
      workspaceId,
      runnerId,
      actorUserId,
      eventType,
      JSON.stringify(payload || {}),
    ],
  );
}

function publicRunnerRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    fingerprint: formatFingerprintGrouped(row.fingerprint_sha256),
    fingerprintSha256: row.fingerprint_sha256,
    hostMetadata: row.host_metadata || {},
    protocolVersion: row.protocol_version,
    runnerVersion: row.runner_version || '',
    connectionState: row.connection_state,
    lastSeenAt: row.last_seen_at,
    connectedAt: row.connected_at,
    capabilities: row.capabilities || {},
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok,
    lastTestMessage: row.last_test_message || '',
    credentialVersion: row.credential_version,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertOwner(scope) {
  assertWorkspaceScope(scope);
  if (String(scope.role || '').toLowerCase() !== 'owner') {
    reject('ROLE_FORBIDDEN', 'owner role required', 403);
  }
}

function assertMember(scope) {
  assertWorkspaceScope(scope);
}

class RunnerControl {
  constructor({
    pool,
    clock = () => Date.now(),
    challengeTtlMs = CHALLENGE_TTL_MS,
    claimTtlMs = CLAIM_TTL_MS,
    heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
    clockSkewMs = CLOCK_SKEW_MS,
    protocolVersion = PROTOCOL_VERSION,
    releaseManifest = null,
    releaseTrustedPublicKeys = {},
    releaseMinimumVersion = '',
    env = {},
  } = {}) {
    if (!pool) throw new Error('RunnerControl requires pool');
    this.pool = pool;
    this.clock = clock;
    this.challengeTtlMs = challengeTtlMs;
    this.claimTtlMs = claimTtlMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.clockSkewMs = clockSkewMs;
    this.protocolVersion = protocolVersion;
    this.releaseManifest = releaseManifest;
    this.releaseTrustedPublicKeys = releaseTrustedPublicKeys;
    this.releaseMinimumVersion = releaseMinimumVersion;
    this.env = env;
  }

  // ── User APIs ──────────────────────────────────────────────────────────

  async listRunners(scope) {
    assertMember(scope);
    await this.#refreshConnectionStates(scope.workspaceId);
    const result = await this.pool.query(
      `select * from runners where workspace_id = $1 order by created_at asc`,
      [scope.workspaceId],
    );
    return result.rows.map(publicRunnerRow);
  }

  async getReleaseManifest(scope, { platform = 'darwin-arm64' } = {}) {
    assertMember(scope);
    if (this.releaseManifest && typeof this.releaseManifest === 'object') {
      return {
        ok: true,
        artifact: normalizeRunnerReleaseManifest(this.releaseManifest, platform, {
          trustedPublicKeys: this.releaseTrustedPublicKeys,
          minimumVersion: this.releaseMinimumVersion,
          now: this.clock,
        }),
      };
    }
    // Default: local development / unavailable honesty.
    const envStatus = process.env.RUNNER_RELEASE_STATUS || 'local_development';
    if (envStatus === 'unavailable') {
      return {
        ok: true,
        artifact: {
          status: 'unavailable',
          version: null,
          platform,
          downloadUrl: null,
          manifestUrl: null,
          sha256: null,
          signature: null,
          publicKeyId: null,
          verification: null,
          notes: 'Signed Runner installer is not published yet. Use a local development build of apps/runner.',
        },
      };
    }
    return {
      ok: true,
      artifact: {
        status: 'local_development',
        version: process.env.RUNNER_DEV_VERSION || '0.1.0-dev',
        platform,
        downloadUrl: null,
        manifestUrl: null,
        sha256: null,
        signature: null,
        publicKeyId: null,
        verification: null,
        notes: 'Local development Runner. Verified signed download requires Phase 8 signing accounts. Open apps/runner on this machine.',
      },
    };
  }

  async startEnrollment(scope, { controlPlaneBaseUrl = '' } = {}) {
    assertOwner(scope);
    const now = this.clock();
    const challengeId = newId('ench');
    const challengeCode = generateHumanCode();
    // Server stores only hash(challengeId:code). Human code is returned once for QR/Desktop.
    const challengeHash = hashOpaque(`${challengeId}:${challengeCode}`);
    const expiresAt = new Date(now + this.challengeTtlMs).toISOString();

    return withTransaction(this.pool, async (client) => {
      // Replace prior unused challenges for this workspace owner.
      await client.query(
        `update runner_enrollment_challenges
         set status = 'replaced', replaced_by = $1
         where workspace_id = $2 and status = 'issued'`,
        [challengeId, scope.workspaceId],
      );

      await client.query(
        `insert into runner_enrollment_challenges
          (id, workspace_id, owner_user_id, human_code_display, protocol_version, status, expires_at)
         values ($1, $2, $3, $4, $5, 'issued', $6)`,
        [
          challengeId,
          scope.workspaceId,
          scope.userId,
          challengeCode,
          this.protocolVersion,
          expiresAt,
        ],
      );
      await client.query(
        `insert into runner_enrollment_challenge_secrets
          (challenge_id, workspace_id, challenge_hash)
         values ($1, $2, $3)`,
        [challengeId, scope.workspaceId, challengeHash],
      );

      await writeAudit(client, {
        workspaceId: scope.workspaceId,
        actorUserId: scope.userId,
        action: 'runner.enrollment.start',
        resourceType: 'runner_enrollment_challenge',
        resourceId: challengeId,
        payload: { expiresAt },
      });
      await writeConnectionEvent(client, {
        workspaceId: scope.workspaceId,
        actorUserId: scope.userId,
        eventType: 'enrollment_started',
        payload: { challengeId, expiresAt },
      });

      const qrPayload = JSON.stringify({
        v: this.protocolVersion,
        kind: 'agent-calendar-runner-enroll',
        baseUrl: String(controlPlaneBaseUrl || '').replace(/\/+$/, ''),
        challengeId,
        code: challengeCode,
      });

      return {
        ok: true,
        enrollment: {
          id: challengeId,
          status: 'issued',
          humanCode: challengeCode,
          qrPayload,
          protocolVersion: this.protocolVersion,
          expiresAt,
          workspaceId: scope.workspaceId,
        },
      };
    });
  }

  async getEnrollment(scope, enrollmentId) {
    assertOwner(scope);
    const id = String(enrollmentId || '').trim();
    if (!id) reject('ENROLLMENT_ID_REQUIRED', 'enrollment id required', 400);

    const challenge = await this.pool.query(
      `select * from runner_enrollment_challenges
       where id = $1 and workspace_id = $2 limit 1`,
      [id, scope.workspaceId],
    );
    if (!challenge.rowCount) reject('ENROLLMENT_NOT_FOUND', 'enrollment not found', 404);
    const ch = challenge.rows[0];

    // Expire if past TTL.
    if (ch.status === 'issued' && new Date(ch.expires_at).getTime() <= this.clock()) {
      await this.pool.query(
        `update runner_enrollment_challenges set status = 'expired' where id = $1 and workspace_id = $2 and status = 'issued'`,
        [id, scope.workspaceId],
      );
      ch.status = 'expired';
    }

    const pending = await this.pool.query(
      `select r.*, c.status as claim_status, c.expires_at as claim_expires_at
       from runners r
       left join runner_pending_claims c on c.runner_id = r.id and c.workspace_id = r.workspace_id
       where r.workspace_id = $1 and r.enrollment_challenge_id = $2
       order by r.created_at desc
       limit 1`,
      [scope.workspaceId, id],
    );

    const runner = pending.rowCount ? publicRunnerRow(pending.rows[0]) : null;
    return {
      ok: true,
      enrollment: {
        id: ch.id,
        status: ch.status,
        humanCode: ch.status === 'issued' ? ch.human_code_display : null,
        protocolVersion: ch.protocol_version,
        expiresAt: ch.expires_at,
        workspaceId: ch.workspace_id,
        consumedAt: ch.consumed_at,
      },
      pendingDevice: runner && runner.status === 'pending' ? {
        runnerId: runner.id,
        fingerprint: runner.fingerprint,
        fingerprintSha256: runner.fingerprintSha256,
        hostMetadata: runner.hostMetadata,
        runnerVersion: runner.runnerVersion,
        protocolVersion: runner.protocolVersion,
        claimStatus: pending.rows[0].claim_status || null,
        claimExpiresAt: pending.rows[0].claim_expires_at || null,
      } : null,
      runner: runner && runner.status !== 'pending' ? runner : null,
    };
  }

  async confirmEnrollment(scope, enrollmentId) {
    assertOwner(scope);
    const id = String(enrollmentId || '').trim();
    if (!id) reject('ENROLLMENT_ID_REQUIRED', 'enrollment id required', 400);

    return withTransaction(this.pool, async (client) => {
      const runnerResult = await client.query(
        `select * from runners
         where workspace_id = $1 and enrollment_challenge_id = $2 and status = 'pending'
         for update`,
        [scope.workspaceId, id],
      );
      if (!runnerResult.rowCount) {
        reject('PENDING_DEVICE_NOT_FOUND', 'no pending device for enrollment', 404);
      }
      const runner = runnerResult.rows[0];

      const claimResult = await client.query(
        `select * from runner_pending_claims
         where runner_id = $1 and workspace_id = $2 and status = 'pending'
         for update`,
        [runner.id, scope.workspaceId],
      );
      if (!claimResult.rowCount) {
        reject('CLAIM_NOT_FOUND', 'pending claim missing', 404);
      }
      const claim = claimResult.rows[0];
      if (new Date(claim.expires_at).getTime() <= this.clock()) {
        await client.query(
          `update runner_pending_claims set status = 'expired' where id = $1`,
          [claim.id],
        );
        reject('CLAIM_EXPIRED', 'claim expired', 401);
      }

      await client.query(
        `update runner_pending_claims set status = 'confirmable' where id = $1`,
        [claim.id],
      );
      // Runner stays pending until device claims credential.
      await writeAudit(client, {
        workspaceId: scope.workspaceId,
        actorUserId: scope.userId,
        action: 'runner.enrollment.confirm',
        resourceType: 'runner',
        resourceId: runner.id,
        payload: { enrollmentId: id, fingerprint: runner.fingerprint_sha256 },
      });
      await writeConnectionEvent(client, {
        workspaceId: scope.workspaceId,
        runnerId: runner.id,
        actorUserId: scope.userId,
        eventType: 'owner_confirmed',
        payload: { enrollmentId: id },
      });

      return {
        ok: true,
        runner: publicRunnerRow(runner),
        pendingDevice: {
          runnerId: runner.id,
          fingerprint: formatFingerprintGrouped(runner.fingerprint_sha256),
          status: 'confirmable',
        },
      };
    });
  }

  async rejectEnrollment(scope, enrollmentId) {
    assertOwner(scope);
    const id = String(enrollmentId || '').trim();
    if (!id) reject('ENROLLMENT_ID_REQUIRED', 'enrollment id required', 400);

    return withTransaction(this.pool, async (client) => {
      const runnerResult = await client.query(
        `select * from runners
         where workspace_id = $1 and enrollment_challenge_id = $2 and status = 'pending'
         for update`,
        [scope.workspaceId, id],
      );
      if (!runnerResult.rowCount) {
        reject('PENDING_DEVICE_NOT_FOUND', 'no pending device for enrollment', 404);
      }
      const runner = runnerResult.rows[0];

      await client.query(
        `update runners set status = 'rejected', connection_state = 'disconnected', updated_at = now()
         where id = $1 and workspace_id = $2`,
        [runner.id, scope.workspaceId],
      );
      await client.query(
        `update runner_pending_claims set status = 'rejected'
         where runner_id = $1 and workspace_id = $2 and status in ('pending', 'confirmable')`,
        [runner.id, scope.workspaceId],
      );
      await writeAudit(client, {
        workspaceId: scope.workspaceId,
        actorUserId: scope.userId,
        action: 'runner.enrollment.reject',
        resourceType: 'runner',
        resourceId: runner.id,
        payload: { enrollmentId: id },
      });
      await writeConnectionEvent(client, {
        workspaceId: scope.workspaceId,
        runnerId: runner.id,
        actorUserId: scope.userId,
        eventType: 'owner_rejected',
        payload: { enrollmentId: id },
      });

      return {
        ok: true,
        runner: publicRunnerRow({ ...runner, status: 'rejected', connection_state: 'disconnected' }),
      };
    });
  }

  async testConnection(scope, runnerId) {
    assertOwner(scope);
    const id = String(runnerId || '').trim();
    if (!id) reject('RUNNER_ID_REQUIRED', 'runner id required', 400);

    await this.#refreshConnectionStates(scope.workspaceId);
    const result = await this.pool.query(
      `select * from runners where id = $1 and workspace_id = $2 limit 1`,
      [id, scope.workspaceId],
    );
    if (!result.rowCount) reject('RUNNER_NOT_FOUND', 'runner not found', 404);
    const runner = result.rows[0];
    if (runner.status !== 'active') {
      reject('RUNNER_NOT_ACTIVE', 'runner is not active', 400);
    }

    const connected = runner.connection_state === 'connected'
      && runner.last_seen_at
      && (this.clock() - new Date(runner.last_seen_at).getTime()) <= this.heartbeatTimeoutMs;

    const caps = runner.capabilities || {};
    const engines = caps.engines || caps;
    const anyAvailable = engines && typeof engines === 'object'
      && Object.values(engines).some(engineCapabilityReady);

    const ok = connected && anyAvailable;
    const message = !connected
      ? 'Runner가 연결되지 않았습니다. 호스트 데몬과 네트워크 연결을 확인하세요.'
      : !anyAvailable
        ? 'Runner는 연결됐지만 사용할 수 있는 실행 엔진이 없습니다. 호스트에서 Codex, Claude, Grok 또는 Hermes를 설치하고 로그인하세요.'
        : 'Runner가 Workspace에 연결되었습니다. 작업 실행 준비가 완료되었습니다.';

    await this.pool.query(
      `update runners set last_test_at = now(), last_test_ok = $1, last_test_message = $2, updated_at = now()
       where id = $3 and workspace_id = $4`,
      [ok, message, id, scope.workspaceId],
    );
    await writeAudit(this.pool, {
      workspaceId: scope.workspaceId,
      actorUserId: scope.userId,
      action: 'runner.connection.test',
      resourceType: 'runner',
      resourceId: id,
      payload: { ok, message },
    });
    await writeConnectionEvent(this.pool, {
      workspaceId: scope.workspaceId,
      runnerId: id,
      actorUserId: scope.userId,
      eventType: 'connection_test',
      payload: { ok, message },
    });

    return {
      ok: true,
      test: {
        runnerId: id,
        passed: ok,
        connected,
        enginesAvailable: Boolean(anyAvailable),
        message,
        testedAt: new Date(this.clock()).toISOString(),
      },
      runner: publicRunnerRow({
        ...runner,
        last_test_at: new Date(this.clock()).toISOString(),
        last_test_ok: ok,
        last_test_message: message,
      }),
    };
  }

  async revokeRunner(scope, runnerId) {
    assertOwner(scope);
    const id = String(runnerId || '').trim();
    if (!id) reject('RUNNER_ID_REQUIRED', 'runner id required', 400);

    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `select * from runners where id = $1 and workspace_id = $2 for update`,
        [id, scope.workspaceId],
      );
      if (!result.rowCount) reject('RUNNER_NOT_FOUND', 'runner not found', 404);
      const runner = result.rows[0];

      await client.query(
        `update runners
         set status = 'revoked',
             connection_state = 'revoked',
             credential_version = credential_version + 1,
             revoked_at = now(),
             active_session_id = null,
             updated_at = now()
         where id = $1 and workspace_id = $2`,
        [id, scope.workspaceId],
      );
      await client.query(
        `delete from runner_credential_secrets where runner_id = $1 and workspace_id = $2`,
        [id, scope.workspaceId],
      );
      await client.query(
        `update runner_sessions set fenced_at = now()
         where runner_id = $1 and workspace_id = $2 and fenced_at is null`,
        [id, scope.workspaceId],
      );
      await client.query(
        `update runner_pending_claims set status = 'rejected'
         where runner_id = $1 and workspace_id = $2 and status in ('pending', 'confirmable')`,
        [id, scope.workspaceId],
      );
      await writeAudit(client, {
        workspaceId: scope.workspaceId,
        actorUserId: scope.userId,
        action: 'runner.revoke',
        resourceType: 'runner',
        resourceId: id,
        payload: { previousStatus: runner.status },
      });
      await writeConnectionEvent(client, {
        workspaceId: scope.workspaceId,
        runnerId: id,
        actorUserId: scope.userId,
        eventType: 'revoked',
        payload: {},
      });

      return {
        ok: true,
        runner: publicRunnerRow({
          ...runner,
          status: 'revoked',
          connection_state: 'revoked',
          revoked_at: new Date(this.clock()).toISOString(),
        }),
      };
    });
  }

  // ── Device APIs ────────────────────────────────────────────────────────

  async deviceEnroll(body = {}) {
    const challengeId = String(body.challengeId || '').trim();
    const challengeCode = String(body.challengeCode || body.code || '').trim().toUpperCase();
    const devicePublicKey = String(body.devicePublicKey || '').trim();
    const signature = String(body.signature || '').trim();
    const protocolVersion = Number(body.protocolVersion || 0);
    const hostName = String(body.hostName || body.host?.name || '').slice(0, 200);
    const hostOs = String(body.hostOs || body.host?.os || '').slice(0, 120);
    const runnerVersion = String(body.runnerVersion || '').slice(0, 80);

    if (!challengeId || !challengeCode || !devicePublicKey || !signature) {
      reject('ENROLL_PARAMS_REQUIRED', 'challengeId, code, devicePublicKey, signature required', 400);
    }
    if (protocolVersion !== this.protocolVersion) {
      reject('PROTOCOL_MISMATCH', 'incompatible protocol version', 400);
    }

    const transcript = canonicalEnrollTranscript({
      challengeId,
      challengeCode,
      devicePublicKey,
      protocolVersion,
      hostName,
      hostOs,
      runnerVersion,
    });
    if (!verifyEd25519(devicePublicKey, transcript, signature)) {
      reject('ENROLL_SIGNATURE_INVALID', 'device signature invalid', 401);
    }

    return withTransaction(this.pool, async (client) => {
      const chResult = await client.query(
        `select * from runner_enrollment_challenges where id = $1 for update`,
        [challengeId],
      );
      if (!chResult.rowCount) reject('CHALLENGE_NOT_FOUND', 'challenge not found', 401);
      const ch = chResult.rows[0];

      if (ch.status === 'replaced' || ch.status === 'expired') {
        reject('CHALLENGE_EXPIRED', 'challenge expired or replaced', 401);
      }
      if (ch.status === 'consumed') {
        reject('CHALLENGE_REPLAY', 'challenge already consumed', 401);
      }
      if (ch.status !== 'issued') {
        reject('CHALLENGE_INVALID', 'challenge not usable', 401);
      }
      if (new Date(ch.expires_at).getTime() <= this.clock()) {
        await client.query(
          `update runner_enrollment_challenges set status = 'expired' where id = $1`,
          [challengeId],
        );
        reject('CHALLENGE_EXPIRED', 'challenge expired', 401);
      }

      const secretRow = await client.query(
        `select challenge_hash from runner_enrollment_challenge_secrets
         where challenge_id = $1 and workspace_id = $2 limit 1`,
        [challengeId, ch.workspace_id],
      );
      const expectedHash = hashOpaque(`${challengeId}:${challengeCode}`);
      if (!secretRow.rowCount || expectedHash !== secretRow.rows[0].challenge_hash) {
        reject('CHALLENGE_CODE_INVALID', 'challenge code invalid', 401);
      }

      // Atomic consume.
      const consume = await client.query(
        `update runner_enrollment_challenges
         set status = 'consumed', consumed_at = now()
         where id = $1 and status = 'issued'
         returning id`,
        [challengeId],
      );
      if (!consume.rowCount) reject('CHALLENGE_REPLAY', 'challenge already consumed', 401);

      const runnerId = newId('run');
      const fingerprint = fingerprintFromPublicKey(devicePublicKey);
      const hostMetadata = {
        hostName,
        hostOs,
        presentedAt: new Date(this.clock()).toISOString(),
      };

      await client.query(
        `insert into runners (
           id, workspace_id, enrollment_challenge_id, status, device_public_key,
           fingerprint_sha256, host_metadata, protocol_version, runner_version,
           connection_state
         ) values ($1, $2, $3, 'pending', $4, $5, $6::jsonb, $7, $8, 'disconnected')`,
        [
          runnerId,
          ch.workspace_id,
          challengeId,
          devicePublicKey,
          fingerprint,
          JSON.stringify(hostMetadata),
          protocolVersion,
          runnerVersion,
        ],
      );

      const claimToken = newOpaque(32);
      const claimId = newId('claim');
      const claimExpires = new Date(this.clock() + this.claimTtlMs).toISOString();
      await client.query(
        `insert into runner_pending_claims
          (id, runner_id, workspace_id, status, expires_at)
         values ($1, $2, $3, 'pending', $4)`,
        [claimId, runnerId, ch.workspace_id, claimExpires],
      );
      await client.query(
        `insert into runner_claim_secrets
          (claim_id, runner_id, workspace_id, claim_token_hash)
         values ($1, $2, $3, $4)`,
        [claimId, runnerId, ch.workspace_id, hashOpaque(claimToken)],
      );

      await writeConnectionEvent(client, {
        workspaceId: ch.workspace_id,
        runnerId,
        eventType: 'device_enrolled_pending',
        payload: { challengeId, fingerprint },
      });

      // Device-only response: claim handle, never credential yet.
      return {
        ok: true,
        runnerId,
        status: 'pending',
        fingerprint: formatFingerprintGrouped(fingerprint),
        fingerprintSha256: fingerprint,
        claimToken,
        claimExpiresAt: claimExpires,
        protocolVersion,
        workspaceId: ch.workspace_id,
      };
    });
  }

  async deviceClaim(body = {}, auth = {}) {
    const runnerId = String(body.runnerId || auth.runnerId || '').trim();
    const claimToken = String(body.claimToken || '').trim();
    const signature = String(body.signature || '').trim();
    const timestampMs = Number(body.timestampMs || auth.timestampMs || 0);
    const nonce = String(body.nonce || auth.nonce || '').trim();

    if (!runnerId || !claimToken || !signature) {
      reject('CLAIM_PARAMS_REQUIRED', 'runnerId, claimToken, signature required', 400);
    }

    return withTransaction(this.pool, async (client) => {
      const runnerResult = await client.query(
        `select * from runners where id = $1 for update`,
        [runnerId],
      );
      if (!runnerResult.rowCount) reject('RUNNER_NOT_FOUND', 'runner not found', 401);
      const runner = runnerResult.rows[0];

      if (runner.status === 'rejected') reject('RUNNER_REJECTED', 'runner rejected', 401);
      if (runner.status === 'revoked') reject('RUNNER_REVOKED', 'runner revoked', 401);
      const existingCred = await client.query(
        `select runner_id from runner_credential_secrets where runner_id = $1 limit 1`,
        [runnerId],
      );
      if (runner.status === 'active' && existingCred.rowCount) {
        reject('CLAIM_ALREADY_USED', 'credential already claimed', 401);
      }
      if (runner.status !== 'pending') {
        reject('RUNNER_NOT_PENDING', 'runner not pending claim', 401);
      }

      const claimResult = await client.query(
        `select * from runner_pending_claims
         where runner_id = $1 and workspace_id = $2
         order by created_at desc limit 1 for update`,
        [runnerId, runner.workspace_id],
      );
      if (!claimResult.rowCount) reject('CLAIM_NOT_FOUND', 'claim not found', 401);
      const claim = claimResult.rows[0];

      if (claim.status === 'claimed') reject('CLAIM_REPLAY', 'claim already used', 401);
      if (claim.status === 'rejected' || claim.status === 'expired') {
        reject('CLAIM_INVALID', 'claim not redeemable', 401);
      }
      if (claim.status !== 'confirmable') {
        // Owner has not confirmed yet — lease denial.
        reject('CLAIM_NOT_CONFIRMABLE', 'owner has not confirmed this device', 403);
      }
      if (new Date(claim.expires_at).getTime() <= this.clock()) {
        await client.query(
          `update runner_pending_claims set status = 'expired' where id = $1`,
          [claim.id],
        );
        reject('CLAIM_EXPIRED', 'claim expired', 401);
      }
      const claimSecret = await client.query(
        `select claim_token_hash from runner_claim_secrets where claim_id = $1 limit 1`,
        [claim.id],
      );
      if (!claimSecret.rowCount || hashOpaque(claimToken) !== claimSecret.rows[0].claim_token_hash) {
        reject('CLAIM_TOKEN_INVALID', 'claim token invalid', 401);
      }

      // Signature over claim transcript.
      const claimTranscript = [
        'claim-v1',
        `runnerId=${runnerId}`,
        `claimToken=${claimToken}`,
        `timestampMs=${timestampMs || this.clock()}`,
        `nonce=${nonce || ''}`,
      ].join('\n');
      if (!verifyEd25519(runner.device_public_key, claimTranscript, signature)) {
        reject('CLAIM_SIGNATURE_INVALID', 'claim signature invalid', 401);
      }

      if (nonce) {
        await this.#consumeNonce(client, runnerId, nonce);
      }

      const deviceCredential = newOpaque(32);
      const credentialVersion = (runner.credential_version || 0) + 1;

      await client.query(
        `update runner_pending_claims set status = 'claimed', claimed_at = now() where id = $1`,
        [claim.id],
      );
      await client.query(
        `update runners
         set status = 'active',
             credential_version = $1,
             updated_at = now()
         where id = $2 and workspace_id = $3`,
        [credentialVersion, runnerId, runner.workspace_id],
      );
      await client.query(
        `insert into runner_credential_secrets
          (runner_id, workspace_id, credential_hash, credential_version)
         values ($1, $2, $3, $4)
         on conflict (runner_id) do update
           set credential_hash = excluded.credential_hash,
               credential_version = excluded.credential_version,
               updated_at = now()`,
        [runnerId, runner.workspace_id, hashOpaque(deviceCredential), credentialVersion],
      );
      await writeConnectionEvent(client, {
        workspaceId: runner.workspace_id,
        runnerId,
        eventType: 'credential_claimed',
        payload: { credentialVersion },
      });

      // Credential ONLY on device channel.
      return {
        ok: true,
        runnerId,
        status: 'active',
        deviceCredential,
        credentialVersion,
        protocolVersion: runner.protocol_version,
        workspaceId: runner.workspace_id,
      };
    });
  }

  async deviceConnect(body = {}, authHeaders = {}) {
    const auth = await this.authenticateDeviceRequest({
      method: 'POST',
      path: '/api/runner/device/connect',
      body,
      headers: authHeaders,
      requireActive: true,
    });

    const clientProtocol = Number(body.protocolVersion || 0);
    if (clientProtocol !== this.protocolVersion) {
      reject('PROTOCOL_MISMATCH', 'incompatible protocol version', 400);
    }

    return withTransaction(this.pool, async (client) => {
      const runner = auth.runner;
      // Fence prior sessions.
      await client.query(
        `update runner_sessions set fenced_at = now()
         where runner_id = $1 and workspace_id = $2 and fenced_at is null`,
        [runner.id, runner.workspace_id],
      );

      const sessionId = newId('rsess');
      const sessionToken = newOpaque(24);
      const cursor = Math.max(Number(runner.active_cursor || 0) + 1, 1);

      await client.query(
        `insert into runner_sessions
          (id, runner_id, workspace_id, protocol_version, cursor, connected_at, last_heartbeat_at)
         values ($1, $2, $3, $4, $5, now(), now())`,
        [sessionId, runner.id, runner.workspace_id, clientProtocol, cursor],
      );
      await client.query(
        `insert into runner_session_secrets
          (session_id, runner_id, workspace_id, session_token_hash)
         values ($1, $2, $3, $4)`,
        [sessionId, runner.id, runner.workspace_id, hashOpaque(sessionToken)],
      );
      await client.query(
        `update runners
         set connection_state = 'connected',
             connected_at = now(),
             last_seen_at = now(),
             active_session_id = $1,
             active_cursor = $2,
             updated_at = now()
         where id = $3 and workspace_id = $4`,
        [sessionId, cursor, runner.id, runner.workspace_id],
      );
      await writeConnectionEvent(client, {
        workspaceId: runner.workspace_id,
        runnerId: runner.id,
        eventType: 'connected',
        payload: { sessionId, cursor },
      });

      return {
        ok: true,
        runnerId: runner.id,
        sessionId,
        sessionToken,
        cursor,
        protocolVersion: clientProtocol,
        connectionState: 'connected',
        workspaceId: runner.workspace_id,
      };
    });
  }

  async deviceHeartbeat(body = {}, authHeaders = {}) {
    const auth = await this.authenticateDeviceRequest({
      method: 'POST',
      path: '/api/runner/device/heartbeat',
      body,
      headers: authHeaders,
      requireActive: true,
      requireSession: true,
    });

    const sessionId = String(body.sessionId || auth.sessionId || '').trim();
    const cursor = body.cursor != null ? Number(body.cursor) : auth.cursor;

    return withTransaction(this.pool, async (client) => {
      const session = await client.query(
        `select * from runner_sessions where id = $1 and runner_id = $2 for update`,
        [sessionId, auth.runner.id],
      );
      if (!session.rowCount) reject('SESSION_NOT_FOUND', 'session not found', 401);
      const sess = session.rows[0];
      if (sess.fenced_at) reject('SESSION_FENCED', 'session fenced', 401);

      // Stale cursor cannot overwrite live state.
      if (cursor != null && Number.isFinite(cursor) && cursor < Number(sess.cursor)) {
        reject('STALE_CURSOR', 'stale reconnect cursor', 409);
      }
      const nextCursor = cursor != null && Number.isFinite(cursor) && cursor > Number(sess.cursor)
        ? cursor
        : Number(sess.cursor);

      await client.query(
        `update runner_sessions set last_heartbeat_at = now(), cursor = $1 where id = $2`,
        [nextCursor, sessionId],
      );
      await client.query(
        `update runners
         set connection_state = 'connected',
             last_seen_at = now(),
             active_cursor = $1,
             updated_at = now()
         where id = $2`,
        [nextCursor, auth.runner.id],
      );

      return {
        ok: true,
        runnerId: auth.runner.id,
        sessionId,
        cursor: nextCursor,
        connectionState: 'connected',
      };
    });
  }

  async deviceCapabilities(body = {}, authHeaders = {}) {
    const auth = await this.authenticateDeviceRequest({
      method: 'POST',
      path: '/api/runner/device/capabilities',
      body,
      headers: authHeaders,
      requireActive: true,
    });

    const engines = body.engines || body.capabilities || {};
    if (!engines || typeof engines !== 'object') {
      reject('CAPABILITIES_REQUIRED', 'engines object required', 400);
    }

    // Reject banned launch args if reported.
    const reportedArgs = JSON.stringify(engines);
    for (const banned of BANNED_LAUNCH_ARGS) {
      if (reportedArgs.includes(banned)) {
        reject('BANNED_LAUNCH_ARGS', `banned launch arg reported: ${banned}`, 400);
      }
    }

    const normalized = {
      engines: normalizeRunnerCapabilities(engines, this.env),
      catalog: normalizeRunnerCapabilityCatalog(body.catalog),
      // Knowledge v2 private-local: Runner reports local search capability (content stays on host).
      localKnowledge: body.localKnowledge === true || body.knowledgeSearch === true || engines.localKnowledge === true,
      knowledgeSearch: body.knowledgeSearch === true || body.localKnowledge === true || engines.knowledgeSearch === true,
      reportedAt: new Date(this.clock()).toISOString(),
      hostRemediation: {
        unavailable: 'Install and authenticate the engine CLI on the Runner host. Provider credentials stay on the host and are never pasted into Agent Calendar.',
      },
    };

    await this.pool.query(
      `update runners set capabilities = $1::jsonb, last_seen_at = now(), updated_at = now() where id = $2`,
      [JSON.stringify(normalized), auth.runner.id],
    );
    await writeConnectionEvent(this.pool, {
      workspaceId: auth.runner.workspace_id,
      runnerId: auth.runner.id,
      eventType: 'capabilities_reported',
      payload: { engines: Object.keys(normalized.engines) },
    });

    return {
      ok: true,
      runnerId: auth.runner.id,
      capabilities: normalized,
    };
  }

  async deviceRotate(body = {}, authHeaders = {}) {
    const auth = await this.authenticateDeviceRequest({
      method: 'POST',
      path: '/api/runner/device/rotate',
      body,
      headers: authHeaders,
      requireActive: true,
    });

    return withTransaction(this.pool, async (client) => {
      const newCredential = newOpaque(32);
      const nextVersion = (auth.runner.credential_version || 0) + 1;
      await client.query(
        `update runners
         set credential_version = $1,
             updated_at = now()
         where id = $2`,
        [nextVersion, auth.runner.id],
      );
      await client.query(
        `insert into runner_credential_secrets
          (runner_id, workspace_id, credential_hash, credential_version)
         values ($1, $2, $3, $4)
         on conflict (runner_id) do update
           set credential_hash = excluded.credential_hash,
               credential_version = excluded.credential_version,
               updated_at = now()`,
        [auth.runner.id, auth.runner.workspace_id, hashOpaque(newCredential), nextVersion],
      );
      // Fence sessions — must reconnect with new credential.
      await client.query(
        `update runner_sessions set fenced_at = now()
         where runner_id = $1 and fenced_at is null`,
        [auth.runner.id],
      );
      await client.query(
        `update runners set active_session_id = null, connection_state = 'reconnecting' where id = $1`,
        [auth.runner.id],
      );
      await writeConnectionEvent(client, {
        workspaceId: auth.runner.workspace_id,
        runnerId: auth.runner.id,
        eventType: 'credential_rotated',
        payload: { credentialVersion: nextVersion },
      });

      return {
        ok: true,
        runnerId: auth.runner.id,
        deviceCredential: newCredential,
        credentialVersion: nextVersion,
      };
    });
  }

  async deviceDisconnect(body = {}, authHeaders = {}) {
    const auth = await this.authenticateDeviceRequest({
      method: 'POST',
      path: '/api/runner/device/disconnect',
      body,
      headers: authHeaders,
      requireActive: true,
      requireSession: false,
    });

    const sessionId = String(body.sessionId || auth.sessionId || '').trim();
    await this.pool.query(
      `update runner_sessions set fenced_at = now()
       where runner_id = $1 and ($2 = '' or id = $2) and fenced_at is null`,
      [auth.runner.id, sessionId],
    );
    await this.pool.query(
      `update runners
       set connection_state = 'disconnected',
           active_session_id = null,
           updated_at = now()
       where id = $1`,
      [auth.runner.id],
    );
    await writeConnectionEvent(this.pool, {
      workspaceId: auth.runner.workspace_id,
      runnerId: auth.runner.id,
      eventType: 'disconnected',
      payload: { sessionId },
    });

    return {
      ok: true,
      runnerId: auth.runner.id,
      connectionState: 'disconnected',
    };
  }

  /**
   * Authenticate a device request: hashed credential + Ed25519 signature + nonce.
   */
  async authenticateDeviceRequest({
    method,
    path,
    body,
    headers = {},
    requireActive = true,
    requireSession = false,
  }) {
    const runnerId = String(headers['x-runner-id'] || headers['X-Runner-Id'] || body.runnerId || '').trim();
    const timestampMs = Number(headers['x-runner-timestamp'] || headers['X-Runner-Timestamp'] || body.timestampMs || 0);
    const nonce = String(headers['x-runner-nonce'] || headers['X-Runner-Nonce'] || body.nonce || '').trim();
    const sessionId = String(headers['x-runner-session'] || headers['X-Runner-Session'] || body.sessionId || '').trim();
    const cursorHeader = headers['x-runner-cursor'] || headers['X-Runner-Cursor'];
    const cursor = cursorHeader != null && cursorHeader !== '' ? Number(cursorHeader) : (body.cursor != null ? Number(body.cursor) : null);
    const credential = String(headers['x-runner-credential'] || headers['X-Runner-Credential'] || body.deviceCredential || '').trim();
    const signature = String(headers['x-runner-signature'] || headers['X-Runner-Signature'] || body.signature || '').trim();

    if (!runnerId || !credential || !signature || !nonce || !timestampMs) {
      reject('DEVICE_AUTH_REQUIRED', 'device auth headers required', 401);
    }

    const now = this.clock();
    if (Math.abs(now - timestampMs) > this.clockSkewMs) {
      reject('CLOCK_SKEW', 'timestamp outside allowed skew', 401);
    }

    const runnerResult = await this.pool.query(
      `select * from runners where id = $1 limit 1`,
      [runnerId],
    );
    if (!runnerResult.rowCount) reject('RUNNER_NOT_FOUND', 'runner not found', 401);
    const runner = runnerResult.rows[0];

    if (runner.status === 'revoked') reject('RUNNER_REVOKED', 'runner revoked', 401);
    if (runner.status === 'rejected') reject('RUNNER_REJECTED', 'runner rejected', 401);
    if (runner.status === 'pending') reject('RUNNER_PENDING', 'pending device cannot authenticate', 401);
    if (requireActive && runner.status !== 'active') {
      reject('RUNNER_NOT_ACTIVE', 'runner not active', 401);
    }
    const credSecret = await this.pool.query(
      `select credential_hash from runner_credential_secrets where runner_id = $1 limit 1`,
      [runnerId],
    );
    if (!credSecret.rowCount) reject('CREDENTIAL_MISSING', 'no credential', 401);
    if (hashOpaque(credential) !== credSecret.rows[0].credential_hash) {
      reject('CREDENTIAL_INVALID', 'credential rejected', 401);
    }
    Object.defineProperty(runner, 'lease_integrity_key', {
      configurable: false,
      enumerable: false,
      value: credSecret.rows[0].credential_hash,
      writable: false,
    });

    const bodyHash = bodySha256(body);
    const transcript = canonicalDeviceTranscript({
      method,
      path,
      bodyHash,
      timestampMs,
      nonce,
      runnerId,
      sessionId,
      cursor: cursor == null ? '' : cursor,
    });
    if (!verifyEd25519(runner.device_public_key, transcript, signature)) {
      reject('DEVICE_SIGNATURE_INVALID', 'device signature invalid', 401);
    }

    await this.#consumeNonce(this.pool, runnerId, nonce);

    if (requireSession) {
      if (!sessionId) reject('SESSION_REQUIRED', 'session required', 401);
      const sess = await this.pool.query(
        `select * from runner_sessions where id = $1 and runner_id = $2 limit 1`,
        [sessionId, runnerId],
      );
      if (!sess.rowCount) reject('SESSION_NOT_FOUND', 'session not found', 401);
      if (sess.rows[0].fenced_at) reject('SESSION_FENCED', 'session fenced', 401);
      if (runner.active_session_id && runner.active_session_id !== sessionId) {
        reject('SESSION_NOT_ACTIVE', 'session is not the live session', 401);
      }
    }

    return {
      runner,
      sessionId,
      cursor,
      timestampMs,
      nonce,
    };
  }

  async #consumeNonce(client, runnerId, nonce) {
    try {
      await client.query(
        `insert into runner_request_nonces (runner_id, nonce, used_at) values ($1, $2, now())`,
        [runnerId, nonce],
      );
    } catch (error) {
      if (error && (error.code === '23505' || /duplicate/i.test(String(error.message)))) {
        reject('NONCE_REPLAY', 'nonce already used', 401);
      }
      throw error;
    }
  }

  async #refreshConnectionStates(workspaceId) {
    const cutoff = new Date(this.clock() - this.heartbeatTimeoutMs).toISOString();
    await this.pool.query(
      `update runners
       set connection_state = 'disconnected', updated_at = now()
       where workspace_id = $1
         and status = 'active'
         and connection_state = 'connected'
         and (last_seen_at is null or last_seen_at < $2::timestamptz)`,
      [workspaceId, cutoff],
    );
  }
}

function normalizeEngine(value) {
  if (!value || typeof value !== 'object') {
    return { available: false, status: 'unavailable', version: null, authStatus: 'unknown', message: 'Not reported' };
  }
  const reportedAvailable = engineReportsAvailability(value);
  const authStatus = engineAuthStatus(value);
  const available = reportedAvailable && engineAuthenticationVerified(value);
  const installed = value.installed === true
    || reportedAvailable
    || Boolean(value.version)
    || String(value.status || '').toLowerCase() === 'auth_required';
  const status = available ? 'available' : installed ? 'auth_required' : 'unavailable';
  const message = available
    ? (value.message || 'Ready on host')
    : installed
      ? 'CLI installed, but authentication is not verified on this Runner host.'
      : (value.message || 'Unavailable on host — install/authenticate on the Runner machine');
  const modelId = (candidate) => {
    const model = String(candidate || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
      && !/^(sk-|bearer|token|cookie|secret)/i.test(model)
      ? model
      : '';
  };
  const models = Array.isArray(value.models)
    ? [...new Set(value.models.map(modelId).filter(Boolean))].slice(0, 100)
    : [];
  const defaultModel = modelId(value.defaultModel);
  return {
    ...(Object.prototype.hasOwnProperty.call(value, 'installed') ? { installed } : {}),
    available,
    status,
    version: value.version != null ? String(value.version) : null,
    authStatus,
    message,
    models,
    defaultModel: defaultModel || null,
    modelSelection: value.modelSelection === 'catalog' ? 'catalog' : 'identifier',
  };
}

module.exports = {
  RunnerControl,
  PROTOCOL_VERSION,
  CHALLENGE_TTL_MS,
  CLAIM_TTL_MS,
  HEARTBEAT_TIMEOUT_MS,
  CLOCK_SKEW_MS,
  BANNED_LAUNCH_ARGS,
  hashOpaque,
  fingerprintFromPublicKey,
  formatFingerprintGrouped,
  canonicalEnrollTranscript,
  canonicalDeviceTranscript,
  bodySha256,
  verifyEd25519,
  generateEd25519Keypair,
  signEd25519,
  normalizeEngine,
  normalizeRunnerCapabilities,
  normalizeRunnerReleaseManifest,
  runnerReleaseConfigurationFromEnv,
  generateHumanCode,
  publicRunnerRow,
};
