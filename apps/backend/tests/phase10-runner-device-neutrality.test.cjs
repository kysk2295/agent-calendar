const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../../..');
const productionRoots = [
  'apps/backend/app/lib',
  'apps/desktop/src',
  'apps/desktop/electron',
  'apps/runner/src',
];
const productionFiles = [
  'apps/backend/app/railway-gateway-server.js',
];
const excludedFiles = new Set([
  'apps/backend/app/lib/macmini-runtime-inventory.js',
]);
const deviceSpecificPattern = /Mac mini|맥미니|맥 미니/;

function sourceFilesUnder(relativeRoot) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];

  return fs.readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(relativePath);
    return /\.(?:js|cjs|mjs|ts|tsx|cts)$/.test(entry.name) ? [relativePath] : [];
  });
}

test('production copy treats execution hosts as user-owned Workspace Runners', () => {
  const offenders = [...productionRoots.flatMap(sourceFilesUnder), ...productionFiles]
    .filter((relativePath) => !excludedFiles.has(relativePath))
    .flatMap((relativePath) => {
      const lines = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8').split('\n');
      return lines.flatMap((line, index) => (
        deviceSpecificPattern.test(line)
          ? [`${relativePath}:${index + 1}: ${line.trim()}`]
          : []
      ));
    });

  assert.deepEqual(
    offenders,
    [],
    `Production code must not hardcode one owner's Mac mini as the product Runner:\n${offenders.join('\n')}`,
  );
});
