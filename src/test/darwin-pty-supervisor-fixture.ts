import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DarwinPtySupervisorRuntime } from '../main/pty/darwin-pty-supervisor';

const REPO = path.resolve(__dirname, '../..');

/**
 * Supervisor Darwin compilado DESTE checkout numa raiz temporária (F-1036).
 *
 * O binário em `resources/native/darwin/` é artefato ignorado pelo git: só o
 * `pretest` (npm test) o gera. Com `npx vitest run` direto ele não existe, e
 * `currentDarwinPtySupervisorRuntime(process.cwd())` ou falha ("supervisor is
 * missing") ou, num worktree aninhado no checkout principal, sobe por
 * `../../../resources` e acha o binário velho do checkout pai — que responde
 * com `usage` e exit 76. Aqui o helper vem da fonte atual e a raiz não tem
 * pai com `resources/`: nada fora dela é candidato.
 */
export function buildTestDarwinPtySupervisor(): {
  readonly runtime: DarwinPtySupervisorRuntime;
  readonly dispose: () => void;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pty-supervisor-fixture-')));
  try {
    execFileSync(process.execPath, [
      path.join(REPO, 'scripts/build-darwin-pty-supervisor.mjs'),
      '--output', path.join(root, 'resources/native/darwin/nexus-pty-supervisor'),
    ], { stdio: 'pipe' });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    runtime: { platform: 'darwin', packaged: false, cwd: root, moduleDir: root },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
