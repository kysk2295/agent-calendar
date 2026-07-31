/**
 * A 503 from the login service is not always transient. When the gateway reports that no
 * identity provider is configured, retrying can never succeed, and telling the user to try
 * again later sends them into a loop against a permanent condition.
 *
 * Kept free of Electron imports so the contract can be tested outside a browser process.
 */
const LOGIN_PROVIDER_UNCONFIGURED = /^(?:WORKOS_CONFIG_MISSING|WORKOS_SDK_UNAVAILABLE|GOOGLE_CONFIG_MISSING|AUTH_PROVIDER_UNAVAILABLE)$/i;

export function desktopLoginStartFailureMessage(status: number, errorCode: string): string {
  const code = String(errorCode || '').trim();
  if (LOGIN_PROVIDER_UNCONFIGURED.test(code)) {
    return '이 서버에 로그인 제공자가 설정되어 있지 않습니다. 다시 시도해도 해결되지 않으며, 서버 설정이 필요합니다.';
  }
  if (status === 503) {
    return '로그인 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하세요.';
  }
  return `로그인을 시작하지 못했습니다 (${code || status}).`;
}
