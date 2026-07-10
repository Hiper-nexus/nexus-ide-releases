import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_BUNDLE_ID = 'com.nexuside.app';
export const DEFAULT_SIGNING_IDENTITY =
  'Developer ID Application: Cleofas Pereira rocha';

const REQUIRED_FUSES = [
  'RunAsNode is Disabled',
  'EnableCookieEncryption is Enabled',
  'EnableNodeOptionsEnvironmentVariable is Disabled',
  'EnableNodeCliInspectArguments is Disabled',
  'EnableEmbeddedAsarIntegrityValidation is Enabled',
  'OnlyLoadAppFromAsar is Enabled',
  'GrantFileProtocolExtraPrivileges is Disabled',
];

function exactlyOne(paths, extension, label) {
  const matches = paths.filter((candidate) =>
    candidate.toLowerCase().endsWith(extension));
  if (matches.length !== 1) {
    throw new Error(
      `release must contain exactly one ${label}; found ${matches.length}`,
    );
  }
  return matches[0];
}

export function assertReleaseArtifacts(paths) {
  return {
    dmg: exactlyOne(paths, '.dmg', 'DMG'),
    zip: exactlyOne(paths, '.zip', 'ZIP (required by Squirrel.Mac updater)'),
  };
}

export function parseCodesignMetadata(output) {
  const authorities = [];
  let teamIdentifier = '';
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('Authority=')) {
      authorities.push(line.slice('Authority='.length).trim());
    }
    if (line.startsWith('TeamIdentifier=')) {
      teamIdentifier = line.slice('TeamIdentifier='.length).trim();
    }
  }
  return { authorities, teamIdentifier };
}

export function assertSignatureMetadata(metadata, teamId, identityName) {
  const expectedAuthority = `${identityName} (${teamId})`;
  if (metadata.teamIdentifier !== teamId) {
    throw new Error(
      `codesign TeamIdentifier mismatch: expected ${teamId}, got ${metadata.teamIdentifier || '<missing>'}`,
    );
  }
  if (metadata.authorities[0] !== expectedAuthority) {
    throw new Error(
      `codesign Authority mismatch: expected ${expectedAuthority}, got ${metadata.authorities[0] || '<missing>'}`,
    );
  }
}

export function expectedEntitlementKeysForPath(filePath, appPath) {
  const normalized = filePath.replaceAll('\\', '/');
  const normalizedApp = appPath.replaceAll('\\', '/').replace(/\/$/u, '');

  if (normalized.includes(' Helper (Plugin).app/')) {
    return ['com.apple.security.cs.allow-unsigned-executable-memory'];
  }
  if (normalized.includes(' Helper (Renderer).app/')) {
    return [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input',
    ];
  }
  if (
    normalized.includes(' Helper.app/') ||
    normalized.includes(' Helper (GPU).app/')
  ) {
    return ['com.apple.security.cs.allow-jit'];
  }
  if (normalized === `${normalizedApp}/Contents/MacOS/NexusIDE`) {
    return [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input',
    ];
  }
  return [];
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} exited ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

async function collectRegularFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile()) {
        files.push(candidate);
      }
    }
  }
  await visit(root);
  return files;
}

async function discoverArtifacts(root) {
  const candidates = await collectRegularFiles(root);
  return assertReleaseArtifacts(candidates);
}

async function findSingleApp(root) {
  const apps = [];
  async function visit(directory, depth) {
    if (depth > 3) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.name === 'NexusIDE.app') {
        apps.push(candidate);
      } else {
        await visit(candidate, depth + 1);
      }
    }
  }
  await visit(root, 0);
  if (apps.length !== 1) {
    throw new Error(`expected exactly one NexusIDE.app in ${root}; found ${apps.length}`);
  }
  return apps[0];
}

function readPlistValue(infoPlist, key) {
  return runChecked('/usr/bin/plutil', [
    '-extract', key, 'raw', '-o', '-', infoPlist,
  ]).stdout.trim();
}

function readEntitlements(binaryPath) {
  const xml = runChecked('/usr/bin/codesign', [
    '-d', '--entitlements', '-', '--xml', binaryPath,
  ]).stdout.trim();
  if (!xml) return {};
  const json = runChecked('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', '-',
  ], { input: xml }).stdout;
  return JSON.parse(json);
}

function assertExactEntitlements(binaryPath, appPath) {
  const actual = Object.keys(readEntitlements(binaryPath)).sort();
  const expected = expectedEntitlementKeysForPath(binaryPath, appPath).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `entitlements mismatch for ${binaryPath}: expected ${expected.join(', ') || '<none>'}; got ${actual.join(', ') || '<none>'}`,
    );
  }
}

async function verifyMachOBinaries(appPath, signing) {
  const files = await collectRegularFiles(appPath);
  let count = 0;
  for (const candidate of files) {
    const fileType = runChecked('/usr/bin/file', ['-b', candidate]).stdout;
    if (!fileType.includes('Mach-O')) continue;
    count += 1;
    runChecked('/usr/bin/codesign', [
      '--verify', '--strict', '--verbose=2', candidate,
    ]);
    const metadata = parseCodesignMetadata(runChecked('/usr/bin/codesign', [
      '-dv', '--verbose=4', candidate,
    ]).combined);
    assertSignatureMetadata(metadata, signing.teamId, signing.identityName);
    assertExactEntitlements(candidate, appPath);
  }
  if (count === 0) throw new Error(`no Mach-O files found in ${appPath}`);
}

async function verifyApp(appPath, expected, signing) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const bundleId = readPlistValue(infoPlist, 'CFBundleIdentifier');
  const version = readPlistValue(infoPlist, 'CFBundleShortVersionString');
  if (bundleId !== expected.bundleId) {
    throw new Error(`bundle ID mismatch: expected ${expected.bundleId}, got ${bundleId}`);
  }
  if (version !== expected.version) {
    throw new Error(`bundle version mismatch: expected ${expected.version}, got ${version}`);
  }

  runChecked('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', appPath,
  ]);
  assertSignatureMetadata(
    parseCodesignMetadata(runChecked('/usr/bin/codesign', [
      '-dv', '--verbose=4', appPath,
    ]).combined),
    signing.teamId,
    signing.identityName,
  );
  runChecked('/usr/sbin/spctl', [
    '--assess', '--type', 'execute', '--verbose=2', appPath,
  ]);
  runChecked('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  await verifyMachOBinaries(appPath, signing);

  const fuses = runChecked('/usr/bin/env', [
    'npx', '--no-install', '@electron/fuses', 'read', '--app', appPath,
  ]).combined;
  for (const required of REQUIRED_FUSES) {
    if (!fuses.includes(required)) {
      throw new Error(`required Electron fuse missing: ${required}`);
    }
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const smoke = runChecked(process.execPath, [
    path.join(scriptDir, 'smoke-packaged-app.mjs'), '--app', appPath,
  ]).combined;
  if (!smoke.includes('[smoke] renderer-mounted')) {
    throw new Error(`artifact smoke lacked renderer proof: ${appPath}`);
  }
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value) {
      throw new Error(`invalid argument near ${flag ?? '<end>'}`);
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function assertConfiguration({ version, teamId, identityName, bundleId }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`invalid release version: ${version || '<missing>'}`);
  }
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error(`invalid Apple Team ID: ${teamId || '<missing>'}`);
  }
  if (!identityName.startsWith('Developer ID Application: ') || /[\r\n]/u.test(identityName)) {
    throw new Error('invalid expected signing identity');
  }
  if (bundleId !== DEFAULT_BUNDLE_ID) {
    throw new Error(`unexpected bundle ID configuration: ${bundleId}`);
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS release verification must run on macOS');
  }
  const args = parseArgs(process.argv.slice(2));
  const artifactsRoot = path.resolve(args.artifacts ?? 'out/make');
  const expected = {
    version: args.version ?? '',
    bundleId: args['bundle-id'] ?? DEFAULT_BUNDLE_ID,
  };
  const signing = {
    teamId: args['team-id'] ?? process.env.APPLE_TEAM_ID ?? '',
    identityName: args.identity ?? DEFAULT_SIGNING_IDENTITY,
  };
  assertConfiguration({ ...expected, ...signing });

  const artifacts = await discoverArtifacts(artifactsRoot);

  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexus-release-verify-'),
  );
  const mountPoint = path.join(temporaryRoot, 'dmg');
  const zipRoot = path.join(temporaryRoot, 'zip');
  let isMounted = false;
  try {
    await fs.mkdir(mountPoint);
    await fs.mkdir(zipRoot);
    runChecked('/usr/bin/hdiutil', [
      'attach', '-readonly', '-nobrowse', '-noautoopen',
      '-mountpoint', mountPoint, artifacts.dmg,
    ]);
    isMounted = true;
    await verifyApp(await findSingleApp(mountPoint), expected, signing);
    runChecked('/usr/bin/ditto', ['-x', '-k', artifacts.zip, zipRoot]);
    await verifyApp(await findSingleApp(zipRoot), expected, signing);
  } finally {
    if (isMounted) {
      try {
        runChecked('/usr/bin/hdiutil', ['detach', '-force', mountPoint]);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }

  console.log(`verified DMG: ${artifacts.dmg}`);
  console.log(`verified updater ZIP: ${artifacts.zip}`);
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
