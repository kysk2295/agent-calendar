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
};

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
  sha256?: string | null;
  signature?: string | null;
  publicKeyId?: string | null;
  notes?: string;
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

export async function listRunners(): Promise<PublicRunner[]> {
  const payload = await hermesApi.listRunners();
  const runners = Array.isArray(payload.runners) ? payload.runners : [];
  return runners as PublicRunner[];
}

export async function getReleaseManifest(): Promise<ReleaseArtifact> {
  const payload = await hermesApi.getRunnerReleaseManifest();
  return asRecord(payload.artifact) as ReleaseArtifact;
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
