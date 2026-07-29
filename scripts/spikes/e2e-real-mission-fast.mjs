// Fast real-mission E2E iteration driver.
//
// Runs a locally Developer-ID-signed packaged .app through the same
// runPackagedRealMission harness the release gate uses. The app does not need
// to come from the release ZIP, but it must pass deep codesign verification;
// ad-hoc packages are rejected before any mission is created.
//
// The releaseBinding records WHAT was tested (the packaged binary hash + real
// commitSha) and uses the Developer ID identity read from codesign. The full
// release-integrity binding (signed ZIP) remains the responsibility of
// `npm run release:candidate`. Use this only for local iteration.
//
//   node scripts/spikes/e2e-real-mission-fast.mjs [--app <path>]

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPackagedRealMission } from '../e2e-real-mission.mjs';
import {
  assertFastRealMissionAppSignature,
} from './e2e-real-mission-signature-preflight.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveHeadSha(rootPath) {
  const dotGitPath = path.join(rootPath, '.git');
  let gitdir = dotGitPath;
  if (!fs.lstatSync(dotGitPath).isDirectory()) {
    const dotGit = fs.readFileSync(dotGitPath, 'utf8').trim();
    const gitdirMatch = dotGit.match(/^gitdir:\s*(.+)$/);
    if (!gitdirMatch) {
      throw new Error(`invalid .git file: ${dotGitPath}`);
    }
    gitdir = path.isAbsolute(gitdirMatch[1])
      ? gitdirMatch[1]
      : path.resolve(rootPath, gitdirMatch[1]);
  }
  let headRef = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
  if (headRef.startsWith('ref:')) {
    const ref = headRef.slice(4).trim();
    const refPath = path.join(gitdir, ref);
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf8').trim();
    // Linked worktree: ref lives in the common dir.
    const common = fs
      .readFileSync(path.join(gitdir, 'commondir'), 'utf8')
      .trim();
    const commonDir = path.isAbsolute(common)
      ? common
      : path.resolve(gitdir, common);
    return fs.readFileSync(path.join(commonDir, ref), 'utf8').trim();
  }
  return headRef;
}

const argv = process.argv.slice(2);
let appPath = path.join(
  root,
  'out',
  'NexusIDE-darwin-arm64',
  'NexusIDE.app',
);
const appFlagIdx = argv.indexOf('--app');
if (appFlagIdx !== -1 && argv[appFlagIdx + 1]) {
  appPath = path.resolve(argv[appFlagIdx + 1]);
}

const binary = path.join(appPath, 'Contents', 'MacOS', 'nexus-ide');
if (!fs.existsSync(binary)) {
  throw new Error(`packaged binary not found: ${binary} (run npm run package)`);
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const verifiedSignature = assertFastRealMissionAppSignature(appPath);
const commitSha = resolveHeadSha(root);
const artifactSha256 = sha256File(binary);

const evidencePath = path.join(
  root,
  'release-artifacts',
  'security',
  'real-mission-evidence-fast.json',
);
fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });

const releaseBinding = {
  appVersion: packageJson.version,
  commitSha,
  artifact: {
    sha256: artifactSha256,
    identity: verifiedSignature.identity,
  },
};

function spawnWithDiagnostics(command, args, options) {
  const child = spawn(command, args, options);
  const forwardOperationalLines = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/u)) {
      if (
        /^\[(?:real-mission|mission-|task-dispatch|nexus|pty)/u.test(line) ||
        /\b(?:failed|blocked|exited|worker_incarnation_lost)\b/iu.test(line)
      ) {
        process.stderr.write(`[app] ${line}\n`);
      }
    }
  };
  child.stdout?.on('data', forwardOperationalLines);
  child.stderr?.on('data', forwardOperationalLines);
  return child;
}

console.error(
  `[fast] app=${path.relative(root, appPath)} ` +
    `commit=${commitSha.slice(0, 12)} binarySha=${artifactSha256.slice(0, 12)} ` +
    `team=${verifiedSignature.teamIdentifier}`,
);

try {
  const { evidence, evidencePath: written } = await runPackagedRealMission(
    appPath,
    {
      evidencePath,
      environment: { ...process.env, NEXUS_REAL_MISSION_PRESERVE_USERDATA: '1' },
      spawnImpl: spawnWithDiagnostics,
      releaseBinding,
    },
  );
  console.error(`[fast] PASS evidence=${path.relative(root, written)}`);
  console.log(JSON.stringify({ status: 'pass', evidencePath: written }, null, 2));
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
}
