import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanWikiVault } from '../dist-electron/wikiScanner.js';

test('scanner creates heading-aware chunks and skips ignored files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-vault-'));
  try {
    await mkdir(path.join(root, '2_wiki'), { recursive: true });
    await mkdir(path.join(root, '.obsidian'), { recursive: true });
    await writeFile(path.join(root, '.obsidian', 'ignored.md'), '# Ignored');
    await writeFile(path.join(root, '2_wiki', 'Market Flow Sentinel.md'), [
      '---',
      'title: Market Flow Sentinel',
      'tags: [trading, risk]',
      'updatedAt: 2026-07-04',
      '---',
      '# Market Flow Sentinel',
      'Intro text.',
      '## 리스크 관리 원칙',
      '손실 한도를 먼저 정하고 포지션을 잡는다.',
      '## 반복 실수',
      '확신이 강할 때 손절을 늦춘다.',
    ].join('\n'));

    const chunks = await scanWikiVault(root);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map((chunk) => chunk.folder), ['2_wiki', '2_wiki', '2_wiki']);
    assert.equal(chunks[0].title, 'Market Flow Sentinel');
    assert.equal(chunks[1].heading, '리스크 관리 원칙');
    assert.deepEqual(chunks[1].headingPath, ['Market Flow Sentinel', '리스크 관리 원칙']);
    assert.match(chunks[1].text, /손실 한도/);
    assert.deepEqual(chunks[1].tags, ['trading', 'risk']);
    assert.equal(chunks[1].updatedAt, '2026-07-04');
    assert.equal(chunks.every((chunk) => !chunk.path.includes('.obsidian')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
