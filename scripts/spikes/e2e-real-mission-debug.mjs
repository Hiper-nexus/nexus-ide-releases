// Igual ao fast, mas TEE do stdout/stderr do app-filho para um arquivo — o
// harness parseia e descarta as linhas; para depurar o gate precisamos delas.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPackagedRealMission } from '../e2e-real-mission.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const appPath = path.join(root, 'out', 'NexusIDE-darwin-arm64', 'NexusIDE.app');
const binary = path.join(appPath, 'Contents', 'MacOS', 'nexus-ide');
const teePath = path.join(root, 'release-artifacts', 'gate-child.log');
const tee = fs.createWriteStream(teePath, { flags: 'w' });

const dotGit = fs.readFileSync(path.join(root, '.git'), 'utf8').trim();
const gitdir = dotGit.match(/^gitdir:\s*(.+)$/)?.[1] ?? path.join(root, '.git');
const headRef = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
let commitSha = headRef;
if (headRef.startsWith('ref:')) {
  const ref = headRef.slice(4).trim();
  const local = path.join(gitdir, ref);
  if (fs.existsSync(local)) commitSha = fs.readFileSync(local, 'utf8').trim();
  else {
    const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    commitSha = fs.readFileSync(path.join(path.isAbsolute(common) ? common : path.resolve(gitdir, common), ref), 'utf8').trim();
  }
}

const spawnTee = (bin, args, opts) => {
  const child = spawn(bin, args, opts);
  child.stdout?.on('data', (c) => tee.write(c));
  child.stderr?.on('data', (c) => tee.write(c));
  return child;
};

try {
  const { evidencePath } = await runPackagedRealMission(appPath, {
    evidencePath: path.join(root, 'release-artifacts', 'security', 'real-mission-evidence-fast.json'),
    environment: { ...process.env, NEXUS_REAL_MISSION_PRESERVE_USERDATA: '1' },
    spawnImpl: spawnTee,
    timeoutMs: 6 * 60_000,
    releaseBinding: {
      appVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      commitSha,
      artifact: { sha256: sha256File(binary), identity: 'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)' },
    },
  });
  console.log('PASS', evidencePath);
} catch (error) {
  console.error('FAIL:', String(error?.message ?? error).slice(0, 400));
  process.exitCode = 1;
}
