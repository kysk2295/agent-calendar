import { hermesApi } from '../../api/hermesApi';

export type RunnerConnectionState = 'disconnected' | 'connected' | 'reconnecting' | 'revoked';
export type RunnerStatus = 'pending' | 'active' | 'rejected' | 'revoked';

export type RunnerEngineCapability = {
  installed?: boolean;
  available?: boolean;
  status?: string;
  version?: string | null;
  authStatus?: string;
  message?: string;
  models?: string[];
  defaultModel?: string | null;
  modelSelection?: 'catalog' | 'identifier';
};

export type RunnerEngineModels = Readonly<{
  models: readonly string[];
  defaultModel: string;
  modelSelection: 'catalog' | 'identifier';
}>;

export type EngineAuthenticationPresentation = Readonly<{
  state: 'authenticated' | 'auth_required' | 'unavailable';
  availabilityLabel: string;
  authLabel: string;
  ready: boolean;
}>;

const verifiedEngineAuthStatuses = new Set(['authenticated', 'ok', 'ready', 'active']);

export function engineAuthenticationPresentation(
  capability: RunnerEngineCapability = {},
): EngineAuthenticationPresentation {
  const authStatus = String(capability.authStatus || '').trim().toLowerCase();
  const reportedAvailable = capability.available === true
    || String(capability.status || '').toLowerCase() === 'available';
  const ready = reportedAvailable && verifiedEngineAuthStatuses.has(authStatus);
  const installed = capability.installed === true
    || reportedAvailable
    || Boolean(capability.version)
    || ['auth_required', 'limited'].includes(String(capability.status || '').toLowerCase());

  if (ready) {
    return {
      state: 'authenticated',
      availabilityLabel: capability.version ? `설치됨 · ${capability.version}` : '설치됨',
      authLabel: 'Runner 인증 확인됨',
      ready: true,
    };
  }
  if (installed) {
    return {
      state: 'auth_required',
      availabilityLabel: '설치됨 · 인증 필요',
      authLabel: 'Runner에서 로그인하세요',
      ready: false,
    };
  }
  return {
    state: 'unavailable',
    availabilityLabel: '설치 필요',
    authLabel: 'Runner 호스트에서 CLI를 설치하세요',
    ready: false,
  };
}

export type PublicRunner = {
  id: string;
  workspaceId?: string;
  status: RunnerStatus | string;
  fingerprint?: string;
  fingerprintSha256?: string;
  hostMetadata?: Record<string, unknown>;
  protocolVersion?: number;
  runnerVersion?: string;
  connectionState?: RunnerConnectionState | string;
  lastSeenAt?: string | null;
  connectedAt?: string | null;
  capabilities?: {
    engines?: Record<string, RunnerEngineCapability>;
    automationSources?: string[];
  } | Record<string, unknown>;
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestMessage?: string;
  credentialVersion?: number;
  revokedAt?: string | null;
  createdAt?: string;
};

export type RunnerEnrollment = {
  id: string;
  status: string;
  humanCode?: string | null;
  qrPayload?: string;
  protocolVersion?: number;
  expiresAt?: string;
  workspaceId?: string;
};

export type ReleaseArtifact = {
  status: 'verified_signed' | 'local_development' | 'unavailable' | string;
  version?: string | null;
  platform?: string;
  downloadUrl?: string | null;
  manifestUrl?: string | null;
  sha256?: string | null;
  signature?: string | null;
  publicKeyId?: string | null;
  notes?: string;
  verification?: {
    status?: string;
    source?: string;
    algorithm?: string;
    manifestSha256?: string;
    artifactSha256?: string;
    publicKeyId?: string;
  } | null;
};

export type EnrollmentSnapshot = {
  ok?: boolean;
  enrollment: RunnerEnrollment;
  pendingDevice?: {
    runnerId?: string;
    fingerprint?: string;
    fingerprintSha256?: string;
    hostMetadata?: Record<string, unknown>;
    runnerVersion?: string;
    protocolVersion?: number;
    claimStatus?: string | null;
  } | null;
  runner?: PublicRunner | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeReleaseArtifact(value: unknown): ReleaseArtifact {
  const record = asRecord(value);
  const platform = typeof record.platform === 'string' ? record.platform : 'darwin-arm64';
  const unavailable: ReleaseArtifact = {
    status: 'unavailable',
    version: null,
    platform,
    downloadUrl: null,
    manifestUrl: null,
    sha256: null,
    signature: null,
    publicKeyId: null,
    notes: 'Runner release metadata could not be verified.',
    verification: null,
  };
  if (record.status === 'local_development') {
    return {
      ...unavailable,
      status: 'local_development',
      version: typeof record.version === 'string' ? record.version : null,
      notes: typeof record.notes === 'string' ? record.notes.slice(0, 240) : '',
    };
  }
  if (record.status !== 'verified_signed') return unavailable;
  const version = typeof record.version === 'string' ? record.version : '';
  const sha256 = typeof record.sha256 === 'string' ? record.sha256 : '';
  const signature = typeof record.signature === 'string' ? record.signature : '';
  const publicKeyId = typeof record.publicKeyId === 'string' ? record.publicKeyId : '';
  const downloadUrl = safeHttpsUrl(record.downloadUrl);
  const manifestUrl = safeHttpsUrl(record.manifestUrl);
  const notes = typeof record.notes === 'string' ? record.notes : '';
  const verification = asRecord(record.verification);
  let signatureBytes = 0;
  try {
    signatureBytes = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)).length;
  } catch {
    signatureBytes = 0;
  }
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || platform !== 'darwin-arm64'
    || !/^[a-f0-9]{64}$/.test(sha256)
    || !/^runner-ed25519-[a-f0-9]{16}$/.test(publicKeyId)
    || signatureBytes !== 64
    || !downloadUrl
    || !manifestUrl
    || verification.status !== 'verified'
    || verification.source !== 'backend_ed25519'
    || verification.algorithm !== 'ed25519'
    || typeof verification.manifestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(verification.manifestSha256)
    || verification.artifactSha256 !== sha256
    || verification.publicKeyId !== publicKeyId
    || /ignore previous|system prompt|verified_signed/i.test(notes)
  ) return unavailable;
  return {
    status: 'verified_signed',
    version,
    platform,
    downloadUrl,
    manifestUrl,
    sha256,
    signature,
    publicKeyId,
    notes: notes.slice(0, 240),
    verification: {
      status: 'verified',
      source: 'backend_ed25519',
      algorithm: 'ed25519',
      manifestSha256: verification.manifestSha256,
      artifactSha256: sha256,
      publicKeyId,
    },
  };
}

export async function listRunners(): Promise<PublicRunner[]> {
  const payload = await hermesApi.listRunners();
  const runners = Array.isArray(payload.runners) ? payload.runners : [];
  return runners as PublicRunner[];
}

export async function getReleaseManifest(): Promise<ReleaseArtifact> {
  const payload = await hermesApi.getRunnerReleaseManifest();
  return normalizeReleaseArtifact(payload.artifact);
}

export async function startEnrollment(controlPlaneBaseUrl?: string): Promise<RunnerEnrollment> {
  const payload = await hermesApi.startRunnerEnrollment(
    controlPlaneBaseUrl ? { controlPlaneBaseUrl } : {},
  );
  return asRecord(payload.enrollment) as RunnerEnrollment;
}

export async function getEnrollment(id: string): Promise<EnrollmentSnapshot> {
  const payload = await hermesApi.getRunnerEnrollment(id);
  return payload as EnrollmentSnapshot;
}

export async function confirmEnrollment(id: string): Promise<unknown> {
  return hermesApi.confirmRunnerEnrollment(id);
}

export async function rejectEnrollment(id: string): Promise<unknown> {
  return hermesApi.rejectRunnerEnrollment(id);
}

export async function testRunner(id: string): Promise<{
  passed: boolean;
  message: string;
  runner?: PublicRunner;
}> {
  const payload = await hermesApi.testRunner(id);
  const test = asRecord(payload.test);
  return {
    passed: test.passed === true,
    message: String(test.message || ''),
    runner: payload.runner as PublicRunner | undefined,
  };
}

export async function revokeRunner(id: string): Promise<PublicRunner | null> {
  const payload = await hermesApi.revokeRunner(id);
  return (payload.runner as PublicRunner) || null;
}

export function engineList(runner: PublicRunner | null | undefined): Array<{ name: string; cap: RunnerEngineCapability }> {
  const caps = runner?.capabilities as { engines?: Record<string, RunnerEngineCapability> } | undefined;
  const engines = caps?.engines || {};
  return ['codex', 'claude', 'grok', 'hermes'].map((name) => ({
    name,
    cap: engines[name] || { available: false, status: 'unavailable', message: 'Not reported' },
  }));
}

export function engineModels(
  runners: readonly PublicRunner[],
  engine: string,
): RunnerEngineModels {
  const capability = runners
    .filter((runner) => runner.status === 'active' && runner.connectionState === 'connected')
    .map((runner) => {
      const engines = (runner.capabilities as { engines?: Record<string, RunnerEngineCapability> } | undefined)?.engines;
      return engines?.[engine];
    })
    .find((candidate) => candidate?.available === true);
  const models = Array.isArray(capability?.models)
    ? capability.models.filter((model) => (
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
      && !/^(sk-|bearer|token|cookie|secret)/i.test(model)
    ))
    : [];
  const reportedDefaultModel = String(capability?.defaultModel || '');
  const defaultModel = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(reportedDefaultModel)
    && !/^(sk-|bearer|token|cookie|secret)/i.test(reportedDefaultModel)
    ? reportedDefaultModel
    : '';
  return {
    models,
    defaultModel,
    modelSelection: capability?.modelSelection === 'catalog' ? 'catalog' : 'identifier',
  };
}
