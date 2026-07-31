import type { RunnerEngineCapability } from './runnerApi';
import {
  buildProviderSections,
  providerSectionHeading,
  type ProviderSection,
} from './providerAccountsPresentation';

export type ProviderAccountsPanelProps = {
  engines: ReadonlyArray<{ name: string; cap: RunnerEngineCapability }>;
  hostLabel?: string;
  busy?: boolean;
  onRefresh?: () => void;
  onAddAccount?: (providerId: string) => void;
  onReauth?: (providerId: string, accountId: string) => void;
  onRemove?: (providerId: string, accountId: string) => void;
};

function ProviderCard({
  section,
  busy,
  onAddAccount,
  onReauth,
  onRemove,
}: {
  section: ProviderSection;
  busy?: boolean;
  onAddAccount?: (providerId: string) => void;
  onReauth?: (providerId: string, accountId: string) => void;
  onRemove?: (providerId: string, accountId: string) => void;
}) {
  const deviceAccounts = section.accounts.filter((account) => account.kind === 'device');
  const systemDefault = section.accounts.find((account) => account.kind === 'system_default');

  return (
    <section
      className="provider-accounts-card"
      data-testid={`provider-card-${section.id}`}
      data-auth-state={section.auth.state}
      data-provider={section.id}
    >
      <header className="provider-accounts-card-head">
        <div>
          <h3>{section.title}</h3>
          <p className="provider-accounts-optional">{providerSectionHeading(section)}</p>
          <p className="provider-accounts-desc">{section.description}</p>
        </div>
        <button
          type="button"
          className="provider-accounts-add"
          data-testid={`provider-add-${section.id}`}
          disabled={busy}
          onClick={() => onAddAccount?.(section.id)}
        >
          + 계정 추가
        </button>
      </header>

      <div className="provider-accounts-block">
        <div className="provider-accounts-block-label">
          <strong>계정</strong>
          <span>Runner 호스트 계정을 표시합니다. 새 계정은 호스트에서 추가됩니다.</span>
        </div>

        {systemDefault && (
          <article
            className="provider-account-row"
            data-kind="system_default"
            data-active={systemDefault.active ? 'true' : 'false'}
            data-testid={`provider-account-${systemDefault.id}`}
          >
            <div>
              <div className="provider-account-title-row">
                <strong>{systemDefault.label}</strong>
                {systemDefault.badge && <span className="provider-account-badge" data-badge="active">{systemDefault.badge}</span>}
              </div>
              <p>{systemDefault.subtitle}</p>
              <small className="provider-account-auth">{section.auth.authLabel}</small>
            </div>
          </article>
        )}

        {deviceAccounts.map((account) => (
          <article
            key={account.id}
            className="provider-account-row"
            data-kind="device"
            data-testid={`provider-account-${account.id}`}
          >
            <div>
              <div className="provider-account-title-row">
                <strong>{account.label}</strong>
                {account.badge && <span className="provider-account-badge" data-badge="device">{account.badge}</span>}
              </div>
              <p>{account.subtitle}</p>
            </div>
            <div className="provider-account-actions">
              <button
                type="button"
                data-testid={`provider-reauth-${account.id}`}
                disabled={busy}
                onClick={() => onReauth?.(section.id, account.id)}
              >
                재인증
              </button>
              <button
                type="button"
                className="danger"
                data-testid={`provider-remove-${account.id}`}
                disabled={busy}
                onClick={() => onRemove?.(section.id, account.id)}
              >
                제거
              </button>
            </div>
          </article>
        ))}

        {deviceAccounts.length === 0 && (
          <div className="provider-accounts-empty" data-testid={`provider-empty-${section.id}`} role="status">
            {section.emptyHint}
          </div>
        )}
      </div>
    </section>
  );
}

export function ProviderAccountsPanel({
  engines,
  hostLabel,
  busy,
  onRefresh,
  onAddAccount,
  onReauth,
  onRemove,
}: ProviderAccountsPanelProps) {
  const sections = buildProviderSections(engines, { hostLabel });

  return (
    <div className="provider-accounts" data-testid="provider-accounts-panel">
      <header className="provider-accounts-head">
        <div>
          <p className="provider-accounts-kicker">선택 사항</p>
          <h2>AI 공급자 계정</h2>
          <p className="provider-accounts-lede">
            선택 사항. 실행 컴퓨터(Runner)가 기존 공급자 로그인과 함께 작동합니다.
            계정 간 전환을 호스트에서 관리하려면 계정을 추가하세요. 자격 증명은 이 앱이 아니라 Runner에 남습니다.
          </p>
        </div>
        {onRefresh && (
          <button type="button" data-testid="provider-accounts-refresh" disabled={busy} onClick={onRefresh}>
            상태 새로고침
          </button>
        )}
      </header>

      <div className="provider-accounts-list">
        {sections.map((section) => (
          <ProviderCard
            key={section.id}
            section={section}
            busy={busy}
            onAddAccount={onAddAccount}
            onReauth={onReauth}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  );
}
