/**
 * Pure presentation for AI provider account management (Orca-style settings).
 * Accounts live on the Runner host; this UI only reflects reported capability truth.
 */
import type { EngineAuthenticationPresentation, RunnerEngineCapability } from './runnerApi';
import { engineAuthenticationPresentation } from './runnerApi';

export type ProviderId = 'claude' | 'codex' | 'grok' | 'hermes' | 'gemini';

export type ProviderAccountKind = 'system_default' | 'device';

export type ProviderAccountRow = Readonly<{
  id: string;
  kind: ProviderAccountKind;
  label: string;
  subtitle: string;
  badge: string | null;
  active: boolean;
  email: string | null;
}>;

export type ProviderSection = Readonly<{
  id: ProviderId;
  title: string;
  description: string;
  auth: EngineAuthenticationPresentation;
  accounts: readonly ProviderAccountRow[];
  emptyHint: string;
  optional: boolean;
}>;

const PROVIDER_COPY: Readonly<Record<ProviderId, { title: string; description: string; optional: boolean }>> = {
  claude: {
    title: 'Claude',
    description:
      '선택 사항. 실행 컴퓨터(Runner)의 Claude 로그인을 사용합니다. 채팅 세션을 이동하지 않고 빠르게 전환하려면 계정을 추가하세요.',
    optional: true,
  },
  codex: {
    title: 'Codex',
    description:
      '선택 사항. Runner의 Codex 로그인을 사용합니다. 빠른 전환이 필요하면 계정을 추가하세요. 인증은 이 기기가 아닌 Runner 호스트에 유지됩니다.',
    optional: true,
  },
  grok: {
    title: 'Grok',
    description: '선택 사항. Runner에 구성된 Grok/xAI 로그인을 사용합니다.',
    optional: true,
  },
  hermes: {
    title: 'Hermes',
    description: 'Runner 호스트의 Hermes 프로필·런타임을 사용합니다.',
    optional: false,
  },
  gemini: {
    title: 'Gemini',
    description: '선택 사항. Gemini 공급자 설정을 구성합니다.',
    optional: true,
  },
};

const DISPLAY_ORDER: readonly ProviderId[] = ['claude', 'codex', 'grok', 'hermes', 'gemini'];

function normalizeProviderId(name: string): ProviderId | null {
  const key = String(name || '').trim().toLowerCase();
  if (key === 'claude' || key === 'anthropic') return 'claude';
  if (key === 'codex' || key === 'openai') return 'codex';
  if (key === 'grok' || key === 'xai') return 'grok';
  if (key === 'hermes') return 'hermes';
  if (key === 'gemini' || key === 'google') return 'gemini';
  return null;
}

function accountEmailFromCapability(cap: RunnerEngineCapability): string | null {
  const message = String(cap.message || '').trim();
  const match = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

export function buildProviderSections(
  engines: ReadonlyArray<{ name: string; cap: RunnerEngineCapability }>,
  options: { hostLabel?: string } = {},
): ProviderSection[] {
  const hostLabel = String(options.hostLabel || '실행 컴퓨터').trim() || '실행 컴퓨터';
  const byId = new Map<ProviderId, RunnerEngineCapability>();

  for (const { name, cap } of engines) {
    const id = normalizeProviderId(name);
    if (id) byId.set(id, cap || {});
  }

  // Always surface core providers so empty/auth-required states are visible.
  for (const id of DISPLAY_ORDER) {
    if (!byId.has(id)) byId.set(id, { available: false, status: 'unavailable' });
  }

  return DISPLAY_ORDER.map((id) => {
    const cap = byId.get(id) || {};
    const auth = engineAuthenticationPresentation(cap);
    const copy = PROVIDER_COPY[id];
    const email = accountEmailFromCapability(cap);
    const accounts: ProviderAccountRow[] = [];

    accounts.push({
      id: `${id}-system-default`,
      kind: 'system_default',
      label: '시스템 기본값',
      subtitle: auth.ready
        ? email
          ? email
          : '현재 이 실행 컴퓨터의 기본 로그인을 사용합니다.'
        : auth.state === 'auth_required'
          ? 'Runner 호스트에서 로그인한 뒤 상태 새로고침을 누르세요.'
          : '이 엔진이 설치·보고되면 기본 로그인이 여기에 표시됩니다.',
      badge: auth.ready ? '활성' : null,
      active: auth.ready,
      email,
    });

    if (auth.ready && email) {
      accounts.push({
        id: `${id}-device-${email}`,
        kind: 'device',
        label: email,
        subtitle: `${email} · ${hostLabel}`,
        badge: '이 기기',
        active: false,
        email,
      });
    }

    const emptyHint = auth.ready
      ? '추가 계정이 없습니다. Runner 호스트에서 계정을 추가하면 여기에 표시됩니다.'
      : auth.state === 'auth_required'
        ? '이 실행 컴퓨터에서 관리되는 계정이 없습니다. Runner에 로그인하면 시스템 기본값이 활성화됩니다.'
        : '이 엔진이 아직 보고되지 않았습니다. Runner 호스트에서 CLI를 설치한 뒤 연결 테스트를 실행하세요.';

    return {
      id,
      title: copy.title,
      description: copy.description,
      auth,
      accounts,
      emptyHint,
      optional: copy.optional,
    };
  });
}

export function providerSectionHeading(section: ProviderSection): string {
  if (section.optional) return `${section.title} · 선택 사항`;
  return section.title;
}
