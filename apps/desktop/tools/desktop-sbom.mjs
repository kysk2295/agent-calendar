import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_SHA = /^[a-f0-9]{40}$/;

function packageEntry(lock, name) {
  const directKey = `node_modules/${name}`;
  if (lock.packages[directKey]) return lock.packages[directKey];
  const suffix = `/node_modules/${name}`;
  const match = Object.entries(lock.packages)
    .filter(([key, entry]) => key.endsWith(suffix) && entry?.version)
    .sort(([left], [right]) => left.length - right.length)[0];
  return match?.[1] || null;
}

function purl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function uuidFromHex(hex) {
  const value = hex.slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function generateDesktopSbom({
  packagePath,
  lockPath,
  sourceSha,
  generatedAt,
}) {
  const normalizedSourceSha = String(sourceSha || '').toLowerCase();
  if (!SOURCE_SHA.test(normalizedSourceSha)) throw new Error('Desktop SBOM source SHA is invalid.');
  const packageDocument = JSON.parse(fs.readFileSync(path.resolve(packagePath), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.resolve(lockPath), 'utf8'));
  const workspaceEntry = lock.packages?.['apps/desktop'];
  if (!workspaceEntry) throw new Error('Desktop workspace is missing from the package lock.');
  const directNames = Object.keys(workspaceEntry.dependencies || packageDocument.dependencies || {});
  const entries = new Map();

  function visit(name) {
    if (entries.has(name)) return;
    const entry = packageEntry(lock, name);
    if (!entry?.version) throw new Error(`Locked Desktop dependency is missing: ${name}`);
    entries.set(name, entry);
    for (const dependencyName of Object.keys(entry.dependencies || {})) visit(dependencyName);
  }
  for (const name of directNames) visit(name);

  const names = [...entries.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  const components = names.map((name) => {
    const entry = entries.get(name);
    return {
      type: 'library',
      'bom-ref': purl(name, entry.version),
      name,
      version: entry.version,
      purl: purl(name, entry.version),
    };
  });
  const rootRef = purl(packageDocument.name, packageDocument.version);
  const dependencies = [
    {
      ref: rootRef,
      dependsOn: directNames
        .filter((name) => entries.has(name))
        .map((name) => purl(name, entries.get(name).version))
        .sort(),
    },
    ...names.map((name) => {
      const entry = entries.get(name);
      return {
        ref: purl(name, entry.version),
        dependsOn: Object.keys(entry.dependencies || {})
          .filter((dependencyName) => entries.has(dependencyName))
          .map((dependencyName) => purl(dependencyName, entries.get(dependencyName).version))
          .sort(),
      };
    }),
  ];
  const serialHash = crypto.createHash('sha256')
    .update(JSON.stringify({ normalizedSourceSha, rootRef, components }))
    .digest('hex');
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuidFromHex(serialHash)}`,
    version: 1,
    metadata: {
      timestamp: generatedAt,
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: packageDocument.name,
        version: packageDocument.version,
        purl: rootRef,
      },
      properties: [
        { name: 'agent-calendar:source-sha', value: normalizedSourceSha },
        { name: 'agent-calendar:scope', value: 'desktop-production-dependencies' },
      ],
    },
    components,
    dependencies,
  };
}

function parseArguments(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid Desktop SBOM argument: ${name || '(missing)'}`);
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

function main() {
  const flags = parseArguments(process.argv.slice(2));
  const sbom = generateDesktopSbom({
    packagePath: flags.package || 'apps/desktop/package.json',
    lockPath: flags.lock || 'package-lock.json',
    sourceSha: flags['source-sha'],
    generatedAt: flags['generated-at'] || new Date().toISOString(),
  });
  const output = path.resolve(flags.output || 'apps/desktop/release/agent-calendar-sbom.cdx.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  process.stdout.write(`${JSON.stringify({
    output,
    components: sbom.components.length,
    sourceSha: flags['source-sha'],
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Desktop SBOM generation failed.'}\n`);
    process.exitCode = 1;
  }
}
