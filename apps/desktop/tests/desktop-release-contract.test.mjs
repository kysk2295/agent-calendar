import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const desktopPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const workflowUrl = new URL('../../../.github/workflows/desktop-release.yml', import.meta.url);
const recoveryPageUrl = new URL('../public/crash-recovery.html', import.meta.url);

test('desktop package publishes staged GitHub update metadata for macOS DMG and ZIP', () => {
  assert.equal(typeof desktopPackage.dependencies['electron-updater'], 'string');
  assert.equal(desktopPackage.build.generateUpdatesFilesForAllChannels, true);
  assert.equal(desktopPackage.build.artifactName, 'Agent-Calendar-${version}-${arch}.${ext}');
  assert.deepEqual(desktopPackage.build.publish, [{
    provider: 'github',
    owner: 'kysk2295',
    repo: 'agent-calendar',
    releaseType: 'draft',
  }]);
  const targets = desktopPackage.build.mac.target.map((target) => target.target);
  assert.deepEqual(targets, ['dmg', 'zip']);
});

test('desktop release workflow is manual, fail-closed, notarized, attested, and draft-only', () => {
  assert.equal(fs.existsSync(workflowUrl), true);
  const workflow = fs.readFileSync(workflowUrl, 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on:\s*macos-14/);
  assert.match(workflow, /environment:\s*desktop-release/);
  assert.match(workflow, /MAC_CERTIFICATE_P12|CSC_LINK/);
  assert.match(workflow, /APPLE_API_KEY_P8/);
  assert.match(workflow, /npm run verify:beta/);
  assert.equal(
    rootPackage.scripts['verify:multi-user-ete'],
    'AGENT_CALENDAR_E2E_TWO_ACCOUNT=1 node apps/desktop/tests/playwright-phase3-golden-ete.cjs',
  );
  assert.match(workflow, /npm run verify:multi-user-ete/);
  assert.match(workflow, /stagingPercentage/);
  assert.match(workflow, /npm sbom/);
  assert.match(workflow, /shasum -a 256/);
  assert.match(workflow, /actions\/attest@[a-f0-9]{40}/);
  assert.match(workflow, /gh release create[\s\S]*--draft/);
  assert.doesNotMatch(workflow, /gh release create[\s\S]*--latest/);
});

test('packaged crash recovery page exists and provides an explicit route back to the app', () => {
  assert.equal(fs.existsSync(recoveryPageUrl), true);
  const page = fs.readFileSync(recoveryPageUrl, 'utf8');
  assert.match(page, /Agent Calendar를 안전하게 멈췄습니다/);
  assert.match(page, /:has\(#dark:target\)/);
  assert.match(page, /href="\.\/index\.html\?recovery=manual"/);
  assert.doesNotMatch(page, /nodeIntegration|ipcRenderer|remote\\./);
});
