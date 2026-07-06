const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderLaunchdPlist({
  label = 'xyz.hermes.os',
  nodePath,
  serverPath,
  programArguments,
  workingDirectory,
  port = 64369,
  environmentVariables,
  stdoutPath,
  stderrPath,
} = {}) {
  const args = Array.isArray(programArguments) && programArguments.length
    ? programArguments
    : [nodePath, serverPath];
  const renderedProgramArguments = args.map((item) => `    <string>${escapeXml(item)}</string>`).join('\n');
  const env = {
    PORT: port,
    ...(environmentVariables || {}),
  };
  const renderedEnvironment = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n` +
    `<dict>\n` +
    `  <key>Label</key>\n` +
    `  <string>${escapeXml(label)}</string>\n` +
    `  <key>ProgramArguments</key>\n` +
    `  <array>\n${renderedProgramArguments}\n  </array>\n` +
    `  <key>WorkingDirectory</key>\n` +
    `  <string>${escapeXml(workingDirectory)}</string>\n` +
    `  <key>EnvironmentVariables</key>\n` +
    `  <dict>\n` +
    `${renderedEnvironment}\n` +
    `  </dict>\n` +
    `  <key>StandardOutPath</key>\n` +
    `  <string>${escapeXml(stdoutPath)}</string>\n` +
    `  <key>StandardErrorPath</key>\n` +
    `  <string>${escapeXml(stderrPath)}</string>\n` +
    `  <key>RunAtLoad</key>\n` +
    `  <true/>\n` +
    `  <key>KeepAlive</key>\n` +
    `  <true/>\n` +
    `</dict>\n` +
    `</plist>\n`;
}

function defaultLaunchdTargetPath(homeDir, label = 'xyz.hermes.os') {
  return path.join(homeDir || process.env.HOME || '.', 'Library', 'LaunchAgents', `${label}.plist`);
}

function launchctlCommands(targetPath) {
  return {
    bootstrap: `launchctl bootstrap gui/$UID ${shellQuote(targetPath)}`,
    unbootstrap: `launchctl bootout gui/$UID ${shellQuote(targetPath)}`,
    print: 'launchctl print gui/$UID/xyz.hermes.os',
  };
}

function launchdUid(uid = process.getuid ? process.getuid() : process.env.UID) {
  return String(uid || process.env.UID || '');
}

function launchctlDomain(uid) {
  return `gui/${launchdUid(uid)}`;
}

function launchctlServiceTarget(label = 'xyz.hermes.os', uid) {
  return `${launchctlDomain(uid)}/${label}`;
}

function normalizeExecError(error) {
  const stderr = error && error.stderr ? String(error.stderr) : '';
  const stdout = error && error.stdout ? String(error.stdout) : '';
  return (stderr || stdout || (error && error.message) || 'launchctl command failed').trim();
}

function sanitizeProcessOutput(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '  ')
    .trim();
}

function checkLaunchctlService({
  label = 'xyz.hermes.os',
  uid,
  execFileSync: execFileSyncImpl = execFileSync,
} = {}) {
  const domainTarget = launchctlServiceTarget(label, uid);
  try {
    const output = execFileSyncImpl('launchctl', ['print', domainTarget], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      label,
      domainTarget,
      loaded: true,
      output: sanitizeProcessOutput(output),
      command: `launchctl print ${domainTarget}`,
    };
  } catch (error) {
    return {
      label,
      domainTarget,
      loaded: false,
      exitCode: Number(error && (error.status ?? error.code)) || 1,
      error: normalizeExecError(error),
      command: `launchctl print ${domainTarget}`,
    };
  }
}

function bootstrapLaunchAgent({
  targetPath,
  uid,
  execFileSync: execFileSyncImpl = execFileSync,
} = {}) {
  const domain = launchctlDomain(uid);
  const args = ['bootstrap', domain, targetPath];
  const output = execFileSyncImpl('launchctl', args, { encoding: 'utf8' });
  return {
    ok: true,
    domain,
    targetPath,
    output: String(output || ''),
    command: `launchctl ${args.join(' ')}`,
  };
}

function bootoutLaunchAgent({
  label = 'xyz.hermes.os',
  uid,
  execFileSync: execFileSyncImpl = execFileSync,
} = {}) {
  const domainTarget = launchctlServiceTarget(label, uid);
  const args = ['bootout', domainTarget];
  const output = execFileSyncImpl('launchctl', args, { encoding: 'utf8' });
  return {
    ok: true,
    label,
    domainTarget,
    output: String(output || ''),
    command: `launchctl ${args.join(' ')}`,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeLaunchdPlist(options = {}) {
  const label = options.label || 'xyz.hermes.os';
  const targetPath = options.targetPath || defaultLaunchdTargetPath(options.homeDir, label);
  const plist = options.plist || renderLaunchdPlist({ ...options, label });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, plist, 'utf8');
  return {
    label,
    targetPath,
    plist,
    commands: launchctlCommands(targetPath),
  };
}

function pathCheck(name, targetPath) {
  return {
    name,
    path: targetPath,
    exists: Boolean(targetPath && fs.existsSync(targetPath)),
  };
}

function checkLaunchdReadiness({ nodePath, serverPath, workingDirectory, targetPath } = {}) {
  const checks = {
    node: pathCheck('node', nodePath),
    server: pathCheck('server', serverPath),
    workingDirectory: pathCheck('workingDirectory', workingDirectory),
    plist: pathCheck('plist', targetPath),
  };
  return {
    ready: Object.values(checks).every((check) => check.exists),
    checks,
  };
}

module.exports = {
  bootstrapLaunchAgent,
  bootoutLaunchAgent,
  checkLaunchctlService,
  checkLaunchdReadiness,
  defaultLaunchdTargetPath,
  escapeXml,
  renderLaunchdPlist,
  writeLaunchdPlist,
};
