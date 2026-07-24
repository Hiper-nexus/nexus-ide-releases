// Variante do debug spike que roda o gate contra um APP EXTERNO (ex.: o
// 0.19.27 assinado instalado) para discriminar regressão-de-código vs
// ambiente-unattended. APP_PATH e APP_VERSION via env.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPackagedRealMission } from '../e2e-real-mission.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const appPath = process.env.APP_PATH ?? '/Applications/NexusIDE.app';
const appVersion = process.env.APP_VERSION ?? '0.19.27';
const binary = path.join(appPath, 'Contents', 'MacOS', 'nexus-ide');
const teePath = path.join(root, 'release-artifacts', 'gate-child-app.log');
const tee = fs.createWriteStream(teePath, { flags: 'w' });

const spawnTee = (bin, args, opts) => {
  const child = spawn(bin, args, opts);
  child.stdout?.on('data', (c) => tee.write(c));
  child.stderr?.on('data', (c) => tee.write(c));
  return child;
};

try {
  const { evidencePath } = await runPackagedRealMission(appPath, {
    evidencePath: path.join(root, 'release-artifacts', 'security', 'real-mission-evidence-app.json'),
    environment: { ...process.env, NEXUS_REAL_MISSION_PRESERVE_USERDATA: '1' },
    spawnImpl: spawnTee,
    timeoutMs: 6 * 60_000,
    releaseBinding: {
      appVersion,
      commitSha: process.env.APP_COMMIT ?? 'e327d59f',
      artifact: { sha256: sha256File(binary), identity: 'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)' },
    },
  });
  console.log('PASS', evidencePath);
} catch (error) {
  console.error('FAIL:', String(error?.message ?? error).slice(0, 400));
  process.exitCode = 1;
}
