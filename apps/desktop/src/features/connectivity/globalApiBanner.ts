type GlobalApiBannerInput = {
  apiError: string;
  screen: string;
  connectivityStatus: string;
  gatewayStatus: Record<string, unknown>;
};

function isExpectedLocalGatewayFallback(gatewayStatus: Record<string, unknown>): boolean {
  return gatewayStatus.gatewayFallback === true
    && gatewayStatus.runtimeReachable === false;
}

export function shouldShowGlobalApiBanner({
  apiError,
  screen,
  connectivityStatus,
  gatewayStatus,
}: GlobalApiBannerInput): boolean {
  return Boolean(
    apiError
    && screen !== 'agents'
    && !['offline', 'reconnecting'].includes(connectivityStatus)
    && !isExpectedLocalGatewayFallback(gatewayStatus),
  );
}
