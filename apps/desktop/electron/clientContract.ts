export const CLIENT_V1_CONTRACT_ID = 'client-v1';
export const CLIENT_V1_MEDIA_TYPE = 'application/vnd.agent-calendar.client-v1+json';
export const CLIENT_CONTRACT_HEADER = 'x-agent-calendar-contract';
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id';
export const CLIENT_IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export function clientV1JsonHeaders(
  additional: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    ...additional,
    accept: `${CLIENT_V1_MEDIA_TYPE}, application/json`,
    [CLIENT_CONTRACT_HEADER]: CLIENT_V1_CONTRACT_ID,
    'content-type': 'application/json',
  };
}
