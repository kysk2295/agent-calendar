'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Arch, Platform, build } = require('electron-builder');

const WIDGET_RELATIVE_PATH = 'build/widget-companion/Agents Calendar Widgets.app';
const WIDGET_EXTENSION_RELATIVE_PATH = path.join(
  WIDGET_RELATIVE_PATH,
  'Contents',
  'PlugIns',
  'HermesWidgets.appex',
);

function resolveMacDmgContents({ projectDir = path.resolve(__dirname, '..') } = {}) {
  const contents = [
    { x: 130, y: 220 },
    { x: 410, y: 220, type: 'link', path: '/Applications' },
  ];
  const extensionPath = path.join(projectDir, WIDGET_EXTENSION_RELATIVE_PATH);
  if (!fs.existsSync(extensionPath) || !fs.statSync(extensionPath).isDirectory()) {
    return { contents, widgetCompanion: 'absent' };
  }
  contents.push({
    x: 130,
    y: 390,
    type: 'file',
    path: WIDGET_RELATIVE_PATH,
  });
  return { contents, widgetCompanion: 'included' };
}

function parseArguments(values) {
  if (values.length === 0) return {};
  if (values.length === 2 && values[0] === '--publish' && values[1] === 'never') {
    return { publish: 'never' };
  }
  throw new Error('supported packaging arguments: --publish never');
}

async function main(values = process.argv.slice(2), environment = process.env) {
  const projectDir = path.resolve(__dirname, '..');
  const { contents, widgetCompanion } = resolveMacDmgContents({ projectDir });
  const sourceSha = String(environment.AGENT_CALENDAR_SOURCE_SHA || '').trim();
  const cli = parseArguments(values);
  process.stderr.write(`widgetCompanion=${widgetCompanion}\n`);
  await build({
    projectDir,
    targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
    publish: cli.publish,
    config: {
      dmg: { contents },
      ...(sourceSha ? { extraMetadata: { sourceSha } } : {}),
    },
  });
}

module.exports = { main, parseArguments, resolveMacDmgContents };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'desktop packaging failed'}\n`);
    process.exitCode = 1;
  });
}
