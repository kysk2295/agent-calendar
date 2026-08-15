import {
  parseSecondBrainRun,
  parseSecondBrainSnapshot,
  type SecondBrainDecision,
  type SecondBrainRun,
  type SecondBrainSnapshot,
} from './secondBrainModel';

type Connection = Readonly<{ baseUrl: string; credential: string }>;
type Options = Readonly<{
  getConnection?: () => Promise<Connection>;
  fetcher?: typeof fetch;
}>;

export type SecondBrainClient = Readonly<{
  getCurrent(): Promise<SecondBrainRun | null>;
  startRun(idempotencyKey: string, sourceIds?: readonly string[]): Promise<SecondBrainRun>;
  getRun(id: string): Promise<SecondBrainRun | null>;
  reviewSnapshot(id: string, decisions: readonly SecondBrainDecision[], activate?: boolean): Promise<SecondBrainSnapshot>;
}>;

const TERMINAL_RUN_STATUSES = new Set([
  'source_required', 'ready_for_review', 'active', 'failed', 'interrupted',
]);

export async function pollSecondBrainRun(
  client: Pick<SecondBrainClient, 'getRun'>,
  runId: string,
  options: Readonly<{
    intervalMs?: number;
    maximumPolls?: number;
    wait?: (milliseconds: number) => Promise<void>;
    onUpdate?: (run: SecondBrainRun) => void;
  }> = {},
): Promise<SecondBrainRun> {
  const intervalMs = Math.max(50, options.intervalMs ?? 350);
  const maximumPolls = Math.max(1, options.maximumPolls ?? 300);
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    const run = await client.getRun(runId);
    if (!run) throw new Error('Second Brain run을 찾을 수 없습니다.');
    options.onUpdate?.(run);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    await wait(intervalMs);
  }
  throw new Error('Second Brain 진행 상태 확인 시간이 초과되었습니다.');
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : {};
}

async function defaultConnection(): Promise<Connection> {
  return window.hermesDesktop?.getHermesConnection
    ? window.hermesDesktop.getHermesConnection()
    : { baseUrl: '', credential: '' };
}

export function createSecondBrainClient(options: Options = {}): SecondBrainClient {
  const getConnection = options.getConnection || defaultConnection;
  const fetcher = options.fetcher || fetch;
  async function request(path: string, init: RequestInit = {}) {
    const connection = await getConnection();
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/vnd.agent-calendar.client-v1+json, application/json');
    headers.set('x-agent-calendar-contract', 'client-v1');
    if (connection.credential) headers.set('x-agent-calendar-proxy-credential', connection.credential);
    if (init.body) headers.set('content-type', 'application/json');
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      const requestId = crypto.randomUUID();
      headers.set('x-client-request-id', requestId);
      headers.set('idempotency-key', requestId);
    }
    const response = await fetcher(`${connection.baseUrl.replace(/\/+$/g, '')}${path}`, { ...init, headers });
    const payload = record(await response.json().catch(() => ({})));
    if (!response.ok) throw new Error(String(payload.message || payload.error || 'Second Brain 요청 실패'));
    return payload;
  }
  function runFrom(payload: Readonly<Record<string, unknown>>) {
    return parseSecondBrainRun(payload.run, payload.snapshot);
  }
  return {
    async getCurrent() { return runFrom(await request('/api/second-brain/current')); },
    async startRun(idempotencyKey, sourceIds) {
      const payload = await request('/api/second-brain/runs', {
        method: 'POST', body: JSON.stringify({ idempotencyKey, ...(sourceIds ? { sourceIds } : {}) }),
      });
      const run = runFrom(payload);
      if (!run) throw new Error('Second Brain run contract invalid');
      return run;
    },
    async getRun(id) { return runFrom(await request(`/api/second-brain/runs/${encodeURIComponent(id)}`)); },
    async reviewSnapshot(id, decisions, activate = false) {
      const payload = await request(`/api/second-brain/snapshots/${encodeURIComponent(id)}/review`, {
        method: 'POST', body: JSON.stringify({ decisions, activate }),
      });
      const snapshot = parseSecondBrainSnapshot(payload.snapshot);
      if (!snapshot) throw new Error('Second Brain snapshot contract invalid');
      return snapshot;
    },
  };
}
