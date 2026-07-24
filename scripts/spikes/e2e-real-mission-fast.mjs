// Fast real-mission E2E iteration driver.
//
// Runs the packaged .app (from `npm run package`) through the same
// runPackagedRealMission harness the release gate uses, but against the
// unsigned packaged build instead of the signed ZIP, so we can iterate on
// the workflow plumbing without `make:release`/notarization (~1 min cycle).
//
// The releaseBinding here is honest about WHAT was tested (the packaged
// binary hash + real commitSha) but the identity is the team Developer ID;
// the real release-integrity binding (signed ZIP) is still verified by the
// full `npm run release:candidate` gate. Use this only for local iteration.
//
//   node scripts/spikes/e2e-real-mission-fast.mjs [--app <path>]

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPackagedRealMission } from '../e2e-real-mission.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveHeadSha(rootPath) {
  const dotGit = fs.readFileSync(path.join(rootPath, '.git'), 'utf8').trim();
  const gitdirMatch = dotGit.match(/^gitdir:\s*(.+)$/);
  let gitdir = gitdirMatch ? gitdirMatch[1] : path.join(rootPath, '.git');
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
const commitSha = resolveHeadSha(root);
const artifactSha256 = sha256File(binary);
const identity =
  'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)';

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
  artifact: { sha256: artifactSha256, identity },
};

console.error(
  `[fast] app=${path.relative(root, appPath)} ` +
    `commit=${commitSha.slice(0, 12)} binarySha=${artifactSha256.slice(0, 12)}`,
);

try {
  const { evidence, evidencePath: written } = await runPackagedRealMission(
    appPath,
    {
      evidencePath,
      environment: { ...process.env, NEXUS_REAL_MISSION_PRESERVE_USERDATA: '1' },
      releaseBinding,
    },
  );
  console.error(`[fast] PASS evidence=${path.relative(root, written)}`);
  console.log(JSON.stringify({ status: 'pass', evidencePath: written }, null, 2));
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
}
