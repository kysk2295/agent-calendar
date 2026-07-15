import type { AgentReport } from './types';

export function currentAgentReportId(reports: readonly AgentReport[], pointer: string): string {
  if (pointer) return pointer;
  let newest: AgentReport | undefined;
  for (const report of reports) {
    const reportOrder = `${report.updatedAt || report.createdAt}\u0000${report.id}`;
    const newestOrder = newest ? `${newest.updatedAt || newest.createdAt}\u0000${newest.id}` : '';
    if (!newest || reportOrder > newestOrder) newest = report;
  }
  return newest?.id || '';
}

export function safeEvidenceHref(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function isDeliverableArtifactHref(value: string): boolean {
  try {
    return /\.(?:docx|pdf|xlsx|pptx|zip)$/i.test(new URL(value).pathname);
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
