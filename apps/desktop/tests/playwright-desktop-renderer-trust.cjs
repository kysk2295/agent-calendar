'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const desktopRoot = path.resolve(__dirname, '..');
const mainJs = path.join(desktopRoot, 'dist-electron', 'main.js');
const evidenceDir = process.env.EVIDENCE_DIR
  || path.join(desktopRoot, 'test-results', 'phase8-renderer-trust');
const userDataName = `Agent Calendar Renderer Trust E2E ${process.pid}`;
const userData = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  userDataName,
);
const attackerPath = path.join(
  os.tmpdir(),
  `agent-calendar-renderer-attacker-${process.pid}.html`,
);

async function main() {
  assert.equal(fs.existsSync(mainJs), true, 'build Electron before renderer trust E2E');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(attackerPath, '<!doctype html><title>Untrusted renderer</title>');

  const electronPath = require('electron');
  const electronApp = await electron.launch({
    executablePath: typeof electronPath === 'string' ? electronPath : undefined,
    args: [mainJs],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENT_CALENDAR_USER_DATA_NAME: userDataName,
      VITE_DEV_SERVER_URL: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await page.waitForSelector('#root', { timeout: 20_000 });
    const trustedUrl = page.url();
    assert.match(trustedUrl, /^file:.*\/dist\/index\.html$/);
    assert.equal(
      await page.evaluate(async () => Boolean(await window.hermesDesktop?.getSessionStatus?.())),
      true,
      'trusted renderer must retain its guarded preload bridge',
    );

    const attemptedUrls = [
      'https://example.com/agent-calendar-untrusted',
      new URL(`file://${attackerPath}`).href,
    ];
    for (const attemptedUrl of attemptedUrls) {
      await page.evaluate((url) => {
        window.location.href = url;
      }, attemptedUrl);
      await page.waitForTimeout(300);
      assert.equal(page.url(), trustedUrl, `renderer escaped to ${attemptedUrl}`);
      assert.equal(
        await page.evaluate(() => typeof window.hermesDesktop?.getSettings === 'function'),
        true,
      );
    }

    const screenshotPath = path.join(evidenceDir, 'trusted-renderer-retained.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const evidence = {
      ok: true,
      trustedUrl,
      attemptedUrls,
      retainedTrustedRenderer: true,
      screenshot: screenshotPath,
    };
    fs.writeFileSync(
      path.join(evidenceDir, 'renderer-trust.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await electronApp.close().catch(() => undefined);
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(attackerPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
