import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArguments(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid candidate verification argument: ${name || '(missing)'}`);
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function requireFile(filePath, name) {
  const resolved = path.resolve(filePath || '');
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Missing ${name}: ${resolved}`);
  }
  if (!stat.isFile() || stat.size < 1) throw new Error(`Missing ${name}: ${resolved}`);
  return resolved;
}

function requireDirectory(directoryPath, name) {
  const resolved = path.resolve(directoryPath || '');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Missing ${name}: ${resolved}`);
  }
  return resolved;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function signingDetails(appPath, requireAppGroup = false) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const details = run('codesign', ['-d', '--verbose=4', appPath]);
  const authorities = [...details.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  const identifier = details.match(/^Identifier=(.+)$/m)?.[1]?.trim() || '';
  const teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || '';
  const cdHash = details.match(/^CDHash=(.+)$/m)?.[1]?.trim() || '';
  if (!authorities.length || !identifier || !teamIdentifier || !cdHash) {
    throw new Error(`Incomplete signing authority inspection for ${appPath}`);
  }
  const entitlements = run('codesign', ['-d', '--entitlements', ':-', appPath]);
  const appGroups = [...entitlements.matchAll(
    /<key>com\.apple\.security\.application-groups<\/key>[\s\S]*?<array>([\s\S]*?)<\/array>/g,
  )].flatMap((match) => (
    [...match[1].matchAll(/<string>([^<]+)<\/string>/g)].map((entry) => entry[1])
  ));
  if (requireAppGroup && !appGroups.includes('group.com.agents.calendar')) {
    throw new Error(`Missing app-group entitlement for ${appPath}`);
  }
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  run('xcrun', ['stapler', 'validate', appPath]);
  return { authorities, identifier, teamIdentifier, cdHash, appGroups };
}

function readJson(filePath, name) {
  return JSON.parse(fs.readFileSync(requireFile(filePath, name), 'utf8'));
}

function main() {
  if (process.platform !== 'darwin') throw new Error('macOS candidate verification requires macOS.');
  const flags = parseArguments(process.argv.slice(2));
  const version = String(flags.version || '');
  const sourceSha = String(flags['source-sha'] || '').toLowerCase();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Candidate version must be stable semantic version.');
  }
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Candidate source SHA is invalid.');

  const desktopApp = requireDirectory(flags['desktop-app'], 'Desktop app');
  const widgetApp = requireDirectory(flags['widget-app'], 'widget companion');
  const mountedDesktopApp = requireDirectory(flags['mounted-desktop-app'], 'mounted Desktop app');
  const mountedWidgetApp = requireDirectory(flags['mounted-widget-app'], 'mounted widget companion');
  const widgetExtension = requireDirectory(
    path.join(widgetApp, 'Contents', 'PlugIns', 'HermesWidgets.appex'),
    'widget extension',
  );
  const mountedWidgetExtension = requireDirectory(
    path.join(mountedWidgetApp, 'Contents', 'PlugIns', 'HermesWidgets.appex'),
    'mounted widget extension',
  );
  const dmg = requireFile(flags.dmg, 'Desktop DMG');
  const zip = requireFile(flags.zip, 'Desktop ZIP');
  const widgetArchive = requireFile(flags['widget-archive'], 'widget archive');
  const smoke = readJson(flags['smoke-evidence'], 'packaged smoke evidence');
  const ordinaryStorage = readJson(
    flags['ordinary-storage-evidence'],
    'ordinary secure-storage evidence',
  );

  const desktop = signingDetails(desktopApp);
  const widget = signingDetails(widgetApp, true);
  const extension = signingDetails(widgetExtension, true);
  const mountedDesktop = signingDetails(mountedDesktopApp);
  const mountedWidget = signingDetails(mountedWidgetApp, true);
  const mountedExtension = signingDetails(mountedWidgetExtension, true);
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);
  run('xcrun', ['stapler', 'validate', dmg]);

  if (
    desktop.cdHash !== mountedDesktop.cdHash
    || widget.cdHash !== mountedWidget.cdHash
    || extension.cdHash !== mountedExtension.cdHash
  ) {
    throw new Error('DMG contents do not match the verified Desktop/widget code signatures.');
  }
  if (
    desktop.teamIdentifier !== widget.teamIdentifier
    || widget.teamIdentifier !== extension.teamIdentifier
  ) {
    throw new Error('Desktop, widget host, and widget extension use different signing teams.');
  }
  if (
    desktop.authorities.join('\n') !== widget.authorities.join('\n')
    || widget.authorities.join('\n') !== extension.authorities.join('\n')
  ) {
    throw new Error('Desktop, widget host, and widget extension use different authorities.');
  }
  if (smoke.ok !== true || smoke.cleanup?.userDataRemoved !== true) {
    throw new Error('Packaged deep-link smoke or cleanup evidence is incomplete.');
  }
  const requiredSmoke = [
    'productionRendererBooted',
    'coldLaunchDeepLink',
    'runningAppDeepLink',
    'invalidUrlRejected',
    'widgetSnapshotHydrated',
    'widgetTogglePersisted',
  ];
  for (const key of requiredSmoke) {
    if (smoke[key] !== true) throw new Error(`Packaged smoke is missing ${key}.`);
  }
  const ordinaryReceipts = [
    ordinaryStorage.appOwnedBootReceipt,
    ordinaryStorage.appOwnedAfterSaveReceipt,
    ordinaryStorage.appOwnedBeforeSnapshotReadReceipt,
    ordinaryStorage.appOwnedAfterSnapshotReadReceipt,
  ];
  if (
    ordinaryStorage.ok !== true
    || ordinaryStorage.qaOverrideAbsent !== true
    || ordinaryReceipts.some((receipt) => receipt?.backend !== 'electron-safe-storage')
    || ordinaryStorage.encryptedFiles?.session !== true
    || ordinaryStorage.encryptedFiles?.snapshot !== true
    || ordinaryStorage.sessionRestored !== true
    || ordinaryStorage.snapshotRestored !== true
    || ordinaryStorage.rendererKeychainErrors !== 0
    || ordinaryStorage.cleanup?.userDataRemoved !== true
  ) {
    throw new Error('Ordinary electron-safe-storage evidence is incomplete or substituted.');
  }

  const widgetSource = fs.readFileSync(path.resolve(
    flags['widget-source'] || 'apps/widget/macos/HermesWidgetHost/HermesWidgets/HermesWidgets.swift',
  ), 'utf8');
  const widgetTypes = [
    'HermesMonthCalendarWidget',
    'HermesTodayWidget',
    'HermesNextEventWidget',
    'HermesAgentStatusWidget',
  ];
  if (widgetTypes.some((name) => !new RegExp(`struct ${name}:\\s*Widget`).test(widgetSource))) {
    throw new Error('The signed companion source does not expose all four required widgets.');
  }

  const evidence = {
    schemaVersion: 1,
    sourceSha,
    tag: `v${version}`,
    version,
    signed: true,
    notarized: true,
    stapled: true,
    ordinarySecureStorage: {
      backend: 'electron-safe-storage',
      qaOverrideAbsent: true,
      sessionEncrypted: true,
      snapshotEncrypted: true,
      sessionRestored: true,
      snapshotRestored: true,
      rendererKeychainErrors: 0,
      cleanupVerified: true,
    },
    desktop: {
      bundleId: desktop.identifier,
      codesignDeepStrict: true,
      gatekeeperAccepted: true,
      staplerValidated: true,
      authorities: desktop.authorities,
      teamIdentifier: desktop.teamIdentifier,
      appGroups: desktop.appGroups,
    },
    widget: {
      hostBundleId: widget.identifier,
      extensionBundleId: extension.identifier,
      separatelySigned: widget.cdHash !== desktop.cdHash,
      packagedInDmg: true,
      fourWidgetsExposed: true,
      appGroupHydrated: true,
      sharedTogglePersisted: true,
      codesignDeepStrict: true,
      gatekeeperAccepted: true,
      staplerValidated: true,
      authorities: widget.authorities,
      teamIdentifier: widget.teamIdentifier,
      appGroups: widget.appGroups,
    },
    packagedSmoke: {
      productionRendererBooted: true,
      coldLaunchDeepLink: true,
      runningAppDeepLink: true,
      invalidUrlRejected: true,
      userDataRemoved: true,
    },
    artifactSha256: {
      dmg: sha256(dmg),
      zip: sha256(zip),
      widgetArchive: sha256(widgetArchive),
    },
  };
  fs.writeFileSync(path.resolve(flags.output), `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Candidate verification failed.'}\n`);
  process.exitCode = 1;
}
