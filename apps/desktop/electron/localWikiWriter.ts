import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type WorkResultWikiProjectionRequest = Readonly<{
  status: 'pending_local';
  workResultId: string;
  projectionId: string;
  relativePath: string;
  markdown: string;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function saveWorkResultWikiProjection(
  vaultPath: string,
  request: unknown,
): Promise<Readonly<{
  status: 'written';
  relativePath: string;
  contentDigest: string;
  replay: boolean;
}>> {
  if (!String(vaultPath || '').trim() || !path.isAbsolute(vaultPath)) {
    throw new Error('로컬 Wiki 폴더를 먼저 연결해 주세요.');
  }
  const source = record(request);
  const workResultId = text(source.workResultId);
  const projectionId = text(source.projectionId);
  const relativePath = text(source.relativePath).replace(/\\/g, '/');
  const markdown = typeof source.markdown === 'string' ? source.markdown : '';
  const expectedPath = `5_conversation/agent-runs/${workResultId}.md`;
  if (source.status !== 'pending_local'
    || !/^work_result_[a-f0-9]{28}$/.test(workResultId)
    || projectionId !== `work-result-wiki:${workResultId}`) {
    throw new Error('Work result projection identity is invalid.');
  }
  if (relativePath !== expectedPath) throw new Error('Work result projection path is invalid.');
  if (!markdown.includes(`\nwork_result_id: ${workResultId}\n`)
    || !markdown.includes('\nstatus: completed\n')
    || !markdown.includes('\nsource: agent-calendar\n')) {
    throw new Error('Work result projection content is invalid.');
  }

  const root = path.resolve(vaultPath);
  const target = path.resolve(root, ...relativePath.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Work result projection path is outside the local Wiki vault.');
  }
  const contentDigest = createHash('sha256').update(markdown, 'utf8').digest('hex');
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, markdown, { encoding: 'utf8', flag: 'wx' });
    return { status: 'written', relativePath, contentDigest, replay: false };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    if (code !== 'EEXIST') throw error;
    const existing = await readFile(target, 'utf8');
    const existingDigest = createHash('sha256').update(existing, 'utf8').digest('hex');
    if (existingDigest !== contentDigest) {
      throw new Error('Work result projection digest conflicts with the existing local Wiki document.');
    }
    return { status: 'written', relativePath, contentDigest, replay: true };
  }
}
