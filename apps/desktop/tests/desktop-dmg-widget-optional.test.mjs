import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  resolveMacDmgContents,
} from '../scripts/electron-builder-mac.cjs';

const WIDGET_RELATIVE_PATH = 'build/widget-companion/Agents Calendar Widgets.app';

test('core desktop DMG omits a missing widget companion', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-dmg-'));
  try {
    const result = resolveMacDmgContents({ projectDir });
    assert.equal(result.widgetCompanion, 'absent');
    assert.equal(result.contents.some((entry) => entry.path === WIDGET_RELATIVE_PATH), false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('official desktop DMG includes a built widget companion with its extension', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-dmg-'));
  const extension = path.join(
    projectDir,
    WIDGET_RELATIVE_PATH,
    'Contents',
    'PlugIns',
    'HermesWidgets.appex',
  );
  try {
    fs.mkdirSync(extension, { recursive: true });
    const result = resolveMacDmgContents({ projectDir });
    assert.equal(result.widgetCompanion, 'included');
    assert.equal(result.contents.some((entry) => (
      entry.type === 'file'
      && entry.path === WIDGET_RELATIVE_PATH
      && entry.x === 130
      && entry.y === 390
    )), true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
