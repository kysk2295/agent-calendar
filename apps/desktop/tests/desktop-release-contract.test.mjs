import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const desktopPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const workflowUrl = new URL('../../../.github/workflows/desktop-release.yml', import.meta.url);
const recoveryPageUrl = new URL('../public/crash-recovery.html', import.meta.url);
const candidateEvidenceSchemaUrl = new URL(
  '../../../docs/operations/schemas/desktop-candidate-verification.schema.json',
  import.meta.url,
);
const updaterEvidenceSchemaUrl = new URL(
  '../../../docs/operations/schemas/desktop-updater-evidence.schema.json',
  import.meta.url,
);
const localUpdaterEvidenceSchemaUrl = new URL(
  '../../../docs/operations/schemas/desktop-local-updater-evidence.schema.json',
  import.meta.url,
);

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
  assert.match(workflow, /desktop-sbom\.mjs/);
  assert.match(workflow, /shasum -a 256/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /codesign -d --verbose=4/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /xcrun stapler validate/);
  assert.match(workflow, /xcodebuild archive/);
  assert.match(workflow, /Agents Calendar Widgets\.app/);
  assert.match(workflow, /test:packaged:deep-link/);
  assert.match(workflow, /live-keychain-source-smoke\.cjs/);
  assert.match(workflow, /--ordinary-storage-evidence/);
  assert.match(workflow, /desktop-candidate-verification\.json/);
  assert.match(workflow, /desktop-updater-evidence\.json/);
  assert.match(workflow, /gh attestation verify/);
  assert.match(workflow, /actions\/attest@[a-f0-9]{40}/);
  assert.match(workflow, /gh release create[\s\S]*--draft/);
  assert.doesNotMatch(workflow, /gh release create[\s\S]*--latest/);
  assert.doesNotMatch(workflow, /allowDowngrade\s*=\s*true/);
  assert.match(workflow, /environment:\s*desktop-release-publication/);
});

test('desktop DMG config places the separately built widget companion beside the Desktop app', () => {
  assert.equal(desktopPackage.build.dmg.contents.some((entry) => (
    entry.type === 'file'
    && entry.path === 'build/widget-companion/Agents Calendar Widgets.app'
  )), true);
  assert.match(
    fs.readFileSync(
      new URL('../../widget/macos/HermesWidgetHost/HermesWidgetHost/HermesWidgetHost.entitlements', import.meta.url),
      'utf8',
    ),
    /group\.com\.agents\.calendar/,
  );
});

test('candidate and updater evidence schemas preserve signed, stapled, SHA-bound manual rollback gates', () => {
  const candidateSchema = JSON.parse(fs.readFileSync(candidateEvidenceSchemaUrl, 'utf8'));
  const updaterSchema = JSON.parse(fs.readFileSync(updaterEvidenceSchemaUrl, 'utf8'));
  const localUpdaterSchema = JSON.parse(fs.readFileSync(localUpdaterEvidenceSchemaUrl, 'utf8'));
  assert.equal(candidateSchema.properties.signed.const, true);
  assert.equal(candidateSchema.properties.notarized.const, true);
  assert.equal(candidateSchema.properties.stapled.const, true);
  assert.equal(candidateSchema.required.includes('ordinarySecureStorage'), true);
  assert.equal(
    candidateSchema.$defs.ordinarySecureStorage.properties.backend.const,
    'electron-safe-storage',
  );
  assert.equal(candidateSchema.$defs.widget.properties.separatelySigned.const, true);
  assert.equal(candidateSchema.$defs.widget.properties.packagedInDmg.const, true);
  assert.equal(updaterSchema.properties.candidateSha256.$ref, '#/$defs/sha256');
  assert.equal(updaterSchema.properties.rollback.properties.manualOnly.const, true);
  assert.equal(
    updaterSchema.properties.rollback.properties.automaticDowngradeAttempted.const,
    false,
  );
  assert.equal(updaterSchema.properties.cleanup.properties.qaUserDataRemoved.const, true);
  assert.equal(localUpdaterSchema.properties.localUnsigned.const, true);
  assert.equal(localUpdaterSchema.properties.publicationEligible.const, false);
  assert.equal(
    localUpdaterSchema.properties.update.properties.signedCandidateVerified.const,
    false,
  );
});

test('packaged crash recovery page exists and provides an explicit route back to the app', () => {
  assert.equal(fs.existsSync(recoveryPageUrl), true);
  const page = fs.readFileSync(recoveryPageUrl, 'utf8');
  assert.match(page, /Agent Calendar를 안전하게 멈췄습니다/);
  assert.match(page, /:has\(#dark:target\)/);
  assert.match(page, /href="\.\/index\.html\?recovery=manual"/);
  assert.doesNotMatch(page, /nodeIntegration|ipcRenderer|remote\\./);
});
