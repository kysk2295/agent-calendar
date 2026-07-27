import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { generateDesktopSbom } from '../tools/desktop-sbom.mjs';

test('desktop SBOM is deterministic, source-bound, transitive, and omits dev-only packages', () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-desktop-sbom-'));
  try {
    const options = {
      packagePath: path.resolve('apps/desktop/package.json'),
      lockPath: path.resolve('package-lock.json'),
      sourceSha: 'a'.repeat(40),
      generatedAt: '2026-07-26T00:00:00.000Z',
    };
    const first = generateDesktopSbom(options);
    const second = generateDesktopSbom(options);
    assert.deepEqual(first, second);
    assert.equal(first.bomFormat, 'CycloneDX');
    assert.equal(first.specVersion, '1.6');
    assert.equal(first.metadata.component.name, 'agents-calendar-desktop');
    assert.equal(
      first.metadata.properties.find((entry) => entry.name === 'agent-calendar:source-sha')?.value,
      'a'.repeat(40),
    );
    const names = first.components.map((component) => component.name);
    assert.equal(names.includes('electron-updater'), true);
    assert.equal(names.includes('react'), true);
    assert.equal(names.includes('electron-builder'), false);
    assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right, 'en')));
    assert.ok(first.components.every((component) => component.purl.startsWith('pkg:npm/')));
    fs.writeFileSync(path.join(outputDirectory, 'sbom.json'), JSON.stringify(first));
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});
