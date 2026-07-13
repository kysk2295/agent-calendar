function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeSessionValue(value: unknown, key = ''): unknown {
  if (/authorization|token|secret|password|chain.?of.?thought|reasoning/i.test(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
      .replace(/(?:token|secret|password)\s*[=:]\s*[^\s]+/gi, '[redacted]')
      .replace(/\/(?:Users|home)\/[^\s"']+/g, '[private-path]');
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeSessionValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeSessionValue(entryValue, entryKey)]),
    );
  }
  return value;
}

export function sanitizeSessionRecord(value: unknown): Readonly<Record<string, unknown>> {
  const sanitized = sanitizeSessionValue(isRecord(value) ? value : {});
  return isRecord(sanitized) ? sanitized : {};
}
