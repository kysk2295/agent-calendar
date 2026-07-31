const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_EVIDENCE_DIR, assertPlaywrightAppRoot } = require('./support/playwright-vite-harness.cjs');

async function main() {
  const url = process.env.HERMES_UI_URL;
  if (!url) throw new Error('HERMES_UI_URL is required; run this scenario through run-playwright-with-vite.cjs');
  const evidenceDir = path.resolve(process.env.PLAYWRIGHT_VITE_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const result = await assertPlaywrightAppRoot({
    url,
    evidenceDir,
    timeoutMs: 20_000,
    screenshotPath: path.join(evidenceDir, 'playwright-app-root-smoke.png'),
  });
  fs.writeFileSync(path.join(evidenceDir, 'playwright-app-root-smoke.json'), `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, url: result.url, status: result.navigation.status }));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
