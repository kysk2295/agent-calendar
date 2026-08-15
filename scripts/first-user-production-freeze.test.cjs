'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { createPackage } = require('@electron/asar');

const { runFreeze } = require('./first-user-production-freeze.cjs');

const PRODUCTION_GATEWAY = 'https://hermes-os-production-e174.up.railway.app';

async function packagedFixture(sourceSha, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-freeze-test-'));
  const source = path.join(root, 'source');
  const appPath = path.join(root, 'Agent Calendar.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  fs.mkdirSync(path.join(source, 'dist', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(source, 'dist-electron'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Contents', 'MacOS', 'Agent Calendar'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'agents-calendar-desktop',
    version: '0.1.0',
    sourceSha: overrides.metadataSha || sourceSha,
  }));
  fs.writeFileSync(path.join(source, 'dist', 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(
    path.join(source, 'dist', 'assets', 'index.js'),
    `globalThis.__visibleDesktopBuild=${JSON.stringify(overrides.rendererSha || sourceSha.slice(0, 12))};console.log('Desktop build');`,
  );
  fs.writeFileSync(
    path.join(source, 'dist-electron', 'main.js'),
    'mainWindow.loadFile(packagedRendererIndexPath());',
  );
  await createPackage(source, path.join(resources, 'app.asar'));
  return {
    appPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('freeze rejects a requested source SHA that is not the repository HEAD before external probes', async () => {
  const head = 'a'.repeat(40);
  let probed = false;

  await assert.rejects(
    runFreeze({
      mode: 'check',
      sourceSha: 'b'.repeat(40),
      appPath: '/does/not/matter.app',
      gateway: 'https://example.invalid',
    }, {
      gitHead: () => head,
      probeRenderer: async () => { probed = true; },
    }),
    /requested source SHA must equal Git HEAD/,
  );
  assert.equal(probed, false);
});

test('freeze fails closed when the packaged app or app.asar is missing', async () => {
  const head = 'a'.repeat(40);
  await assert.rejects(
    runFreeze({
      mode: 'check',
      sourceSha: head,
      appPath: '/definitely/missing/Agent Calendar.app',
      gateway: 'https://example.invalid',
    }, { gitHead: () => head }),
    /packaged app required/,
  );
});

test('freeze requires packaged metadata to contain the exact requested source SHA', async () => {
  const head = 'a'.repeat(40);
  const fixture = await packagedFixture(head, { metadataSha: 'b'.repeat(40) });
  try {
    await assert.rejects(
      runFreeze({
        mode: 'check',
        sourceSha: head,
        appPath: fixture.appPath,
        gateway: 'https://example.invalid',
      }, { gitHead: () => head }),
      /packaged metadata source SHA must equal requested source SHA/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('freeze rejects a renderer that did not boot from the packaged app.asar file URL', async () => {
  const head = 'a'.repeat(40);
  const fixture = await packagedFixture(head);
  try {
    await assert.rejects(
      runFreeze({
        mode: 'check',
        sourceSha: head,
        appPath: fixture.appPath,
        gateway: 'https://example.invalid',
      }, {
        gitHead: () => head,
        probeRenderer: async () => 'http://127.0.0.1:5173/',
        verifyCodesign: () => undefined,
      }),
      /renderer must use the packaged app\.asar file URL/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('freeze requires the visible renderer build id to equal the requested source SHA prefix', async () => {
  const head = 'a'.repeat(40);
  const fixture = await packagedFixture(head, { rendererSha: 'b'.repeat(12) });
  const rendererPath = path.join(
    fixture.appPath,
    'Contents',
    'Resources',
    'app.asar',
    'dist',
    'index.html',
  );
  try {
    await assert.rejects(
      runFreeze({
        mode: 'check',
        sourceSha: head,
        appPath: fixture.appPath,
        gateway: 'https://example.invalid',
      }, {
        gitHead: () => head,
        probeRenderer: async () => pathToFileURL(rendererPath).href,
      }),
      /visible renderer build id must equal requested source SHA prefix/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('freeze requires codesign deep strict verification', async () => {
  const head = 'a'.repeat(40);
  const fixture = await packagedFixture(head);
  const rendererPath = path.join(fixture.appPath, 'Contents', 'Resources', 'app.asar', 'dist', 'index.html');
  try {
    await assert.rejects(
      runFreeze({
        mode: 'check',
        sourceSha: head,
        appPath: fixture.appPath,
        gateway: 'https://example.invalid',
      }, {
        gitHead: () => head,
        probeRenderer: async () => pathToFileURL(rendererPath).href,
        verifyCodesign: () => { throw new Error('unsigned fixture'); },
      }),
      /codesign --verify --deep --strict failed/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('freeze requires Railway health and ready endpoints to return HTTP 200', async () => {
  const head = 'a'.repeat(40);
  const fixture = await packagedFixture(head);
  const rendererPath = path.join(fixture.appPath, 'Contents', 'Resources', 'app.asar', 'dist', 'index.html');
  try {
    await assert.rejects(
      runFreeze({
        mode: 'check',
        sourceSha: head,
        appPath: fixture.appPath,
        gateway: PRODUCTION_GATEWAY,
      }, {
        gitHead: () => head,
        probeRenderer: async () => pathToFileURL(rendererPath).href,
        verifyCodesign: () => undefined,
        fetchImpl: async (url) => ({
          status: String(url).endsWith('/api/ready') ? 503 : 200,
          json: async () => ({}),
        }),
      }),
      /Railway \/api\/ready must return HTTP 200/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('freeze rejects local and unrelated gateways before making any request', async () => {
  const head = 'a'.repeat(40);
  const fixture = await packagedFixture(head);
  const rendererPath = path.join(fixture.appPath, 'Contents', 'Resources', 'app.asar', 'dist', 'index.html');
  let requests = 0;
  const dependencies = {
    gitHead: () => head,
    probeRenderer: async () => pathToFileURL(rendererPath).href,
    verifyCodesign: () => undefined,
    fetchImpl: async () => {
      requests += 1;
      return { status: 200, json: async () => ({ buildCommit: head.slice(0, 12) }) };
    },
  };
  try {
    for (const gateway of [
      'http://127.0.0.1:3000',
      'https://example.com',
      `${PRODUCTION_GATEWAY}/`,
      `${PRODUCTION_GATEWAY}/api/health`,
      `${PRODUCTION_GATEWAY}?candidate=other`,
      'https://user:password@hermes-os-production-e174.up.railway.app',
    ]) {
      await assert.rejects(
        runFreeze({ mode: 'check', sourceSha: head, appPath: fixture.appPath, gateway }, dependencies),
        /production gateway must be exactly/,
      );
    }
    assert.equal(requests, 0);
  } finally {
    fixture.cleanup();
  }
});

test('freeze rejects a gateway-status build identity that does not match the requested source SHA', async () => {
  const head = 'a'.repeat(40);
  const fixture = await packagedFixture(head);
  const rendererPath = path.join(fixture.appPath, 'Contents', 'Resources', 'app.asar', 'dist', 'index.html');
  try {
    await assert.rejects(
      runFreeze({
        mode: 'check',
        sourceSha: head,
        appPath: fixture.appPath,
        gateway: PRODUCTION_GATEWAY,
      }, {
        gitHead: () => head,
        probeRenderer: async () => pathToFileURL(rendererPath).href,
        verifyCodesign: () => undefined,
        fetchImpl: async (url) => ({
          status: 200,
          json: async () => (String(url).endsWith('/api/gateway-status')
            ? { buildCommit: 'b'.repeat(12), deploymentId: 'deployment-fixture' }
            : {}),
        }),
      }),
      /gateway-status build identity must match requested source SHA/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('freeze check returns a secret-free identity receipt with the app.asar SHA256', async () => {
  const head = 'a'.repeat(40);
  const secret = 'sk_must_not_appear';
  const fixture = await packagedFixture(head);
  const asarPath = path.join(fixture.appPath, 'Contents', 'Resources', 'app.asar');
  const rendererPath = path.join(asarPath, 'dist', 'index.html');
  try {
    const receipt = await runFreeze({
      mode: 'check',
      sourceSha: head,
      appPath: fixture.appPath,
      gateway: PRODUCTION_GATEWAY,
    }, {
      gitHead: () => head,
      now: () => '2026-08-16T00:00:00.000Z',
      probeRenderer: async () => pathToFileURL(rendererPath).href,
      verifyCodesign: () => undefined,
      fetchImpl: async (url) => ({
        status: 200,
        json: async () => (String(url).endsWith('/api/gateway-status')
          ? {
            buildCommit: head.slice(0, 12),
            deploymentId: 'deployment-fixture',
            runtimeToken: secret,
          }
          : { secret }),
      }),
    });

    assert.deepEqual(receipt, {
      schemaVersion: 1,
      kind: 'first_user_production_freeze',
      mode: 'check',
      readyToFreeze: true,
      checkedAt: '2026-08-16T00:00:00.000Z',
      sourceSha: head,
      packaged: {
        appBundle: 'Agent Calendar.app',
        renderer: 'file://…/Agent Calendar.app/Contents/Resources/app.asar/dist/index.html',
        metadataSourceSha: head,
        rendererBuildId: head.slice(0, 12),
        asarSha256: createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex'),
        codesignDeepStrict: true,
      },
      railway: {
        origin: PRODUCTION_GATEWAY,
        healthStatus: 200,
        readyStatus: 200,
        gatewayStatus: 200,
        identityField: 'buildCommit',
        buildIdentity: head.slice(0, 12),
      },
    });
    assert.equal(JSON.stringify(receipt).includes(secret), false);
  } finally {
    fixture.cleanup();
  }
});

test('write mode atomically persists the verified receipt while check mode does not', async () => {
  const head = 'a'.repeat(40);
  const fixture = await packagedFixture(head);
  const asarPath = path.join(fixture.appPath, 'Contents', 'Resources', 'app.asar');
  const rendererPath = path.join(asarPath, 'dist', 'index.html');
  const receiptPath = path.join(path.dirname(fixture.appPath), 'evidence', 'receipt.json');
  const dependencies = {
    gitHead: () => head,
    now: () => '2026-08-16T00:00:00.000Z',
    probeRenderer: async () => pathToFileURL(rendererPath).href,
    verifyCodesign: () => undefined,
    fetchImpl: async (url) => ({
      status: 200,
      json: async () => (String(url).endsWith('/api/gateway-status')
        ? { sourceSha: head, buildCommit: head.slice(0, 12) }
        : {}),
    }),
  };
  try {
    await runFreeze({
      mode: 'check',
      sourceSha: head,
      appPath: fixture.appPath,
      gateway: PRODUCTION_GATEWAY,
      receiptPath,
    }, dependencies);
    assert.equal(fs.existsSync(receiptPath), false);

    const receipt = await runFreeze({
      mode: 'write',
      sourceSha: head,
      appPath: fixture.appPath,
      gateway: PRODUCTION_GATEWAY,
      receiptPath,
    }, dependencies);
    assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), receipt);
    assert.equal(receipt.mode, 'write');
    assert.equal(fs.readdirSync(path.dirname(receiptPath)).some((name) => name.includes('.tmp-')), false);
  } finally {
    fixture.cleanup();
  }
});

test('CLI check fails closed without an explicit source SHA and never prints environment secrets', () => {
  const secret = 'railway_secret_must_not_print';
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'first-user-production-freeze.cjs'),
    '--check',
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, RAILWAY_TOKEN: secret, AGENT_CALENDAR_SOURCE_SHA: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requested source SHA must be exactly 40 lowercase hex characters/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});

test('Desktop packaging embeds the full source SHA in metadata and its 12-char prefix in the renderer', () => {
  const desktopPackage = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'desktop', 'package.json'),
    'utf8',
  ));
  const viteConfig = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'desktop', 'vite.config.ts'),
    'utf8',
  );

  assert.equal(
    desktopPackage.build.extraMetadata,
    undefined,
  );
  assert.equal(
    desktopPackage.scripts['dist:mac'],
    'npm run build && electron-builder --mac dmg zip --arm64',
  );
  assert.match(desktopPackage.scripts['dist:mac:frozen'], /test -n "\$AGENT_CALENDAR_SOURCE_SHA"/);
  assert.match(
    desktopPackage.scripts['dist:mac:frozen'],
    /-c\.extraMetadata\.sourceSha="\$AGENT_CALENDAR_SOURCE_SHA"/,
  );
  assert.match(viteConfig, /process\.env\.AGENT_CALENDAR_SOURCE_SHA/);
  assert.match(viteConfig, /desktopBuildId[\s\S]*?\.slice\(0, 12\)/);
});
