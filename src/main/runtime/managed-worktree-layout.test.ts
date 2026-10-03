import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { digest, worktreeTaskKey } from './worktree-contract';
import {
  WINDOWS_GIT_WORKTREE_PATH_LIMIT,
  acceptedCandidatePaths,
  acceptedWorktreePaths,
  acceptedWorktreeRelativePaths,
  legacyWorktreesRoot,
  managedCandidateRelativePath,
  managedCandidatesRoot,
  managedWorktreeRelativePath,
  managedWorktreesRoot,
} from './managed-worktree-layout';

const projectId = 'project-341902b3b280ade48f9cd4cdad567f82a3abd0216afb37faeccce9bf7f9a8e71';
const checkoutId = 'checkout-d0f538713c44f6918ed85eb224ec7000955d564b7f2b21165eea80db265c804e';
const taskKey = worktreeTaskKey('space-a', 'tab');
// O runtime real de um checkout no Windows (userData do Electron).
const baseDirectory = 'C:\\Users\\Administrador\\AppData\\Roaming\\NexusIDE\\project-runtime';
const runtimeDirectory = [
  baseDirectory,
  'projects',
  `project-${'a'.repeat(64)}`,
  `checkout-${'b'.repeat(64)}`,
].join('\\');

describe('managed worktree layout (F-654)', () => {
  it('mantém os componentes históricos e usa novas raízes noindex só no macOS', () => {
    const location = { runtimeDirectory: '/rt/checkout', baseDirectory: '/rt' };
    expect(managedWorktreesRoot(location, 'darwin')).toBe(path.join('/rt/checkout', 'worktrees.noindex'));
    expect(managedCandidatesRoot(location, 'darwin')).toBe(path.join('/rt/checkout', 'merge-candidates.noindex'));
    expect(managedWorktreesRoot(location, 'linux')).toBe(path.join('/rt/checkout', 'worktrees'));
    expect(managedCandidatesRoot(location, 'linux')).toBe(path.join('/rt/checkout', 'merge-candidates'));
    expect(managedWorktreeRelativePath(projectId, checkoutId, taskKey, 'darwin')).toBe(
      path.join(
        `project-${digest('worktree-project', projectId)}`,
        `checkout-${digest('worktree-checkout', projectId, checkoutId)}`,
        `task-${taskKey}`,
      ),
    );
    expect(managedCandidateRelativePath('s'.repeat(64), 'c'.repeat(64), 'darwin')).toBe(
      path.join(`scope-${'s'.repeat(64)}`, `candidate-${'c'.repeat(64)}`),
    );
    expect(acceptedWorktreeRelativePaths(projectId, checkoutId, taskKey, 'darwin')).toHaveLength(1);
  });

  it('aceita no macOS tanto o caminho novo quanto o legado exato, sem mover nenhum deles', () => {
    const location = { runtimeDirectory: '/rt/checkout', baseDirectory: '/rt' };
    const relative = managedWorktreeRelativePath(projectId, checkoutId, taskKey, 'darwin');
    const roots = { worktreesRoot: '/rt/checkout/worktrees.noindex',
      legacyWorktreesRoot: legacyWorktreesRoot(location.runtimeDirectory) };
    expect(acceptedWorktreePaths(roots, projectId, checkoutId, taskKey, 'darwin')).toEqual([
      path.join(roots.worktreesRoot, relative), path.join(roots.legacyWorktreesRoot, relative),
    ]);
    expect(acceptedWorktreePaths(roots, projectId, checkoutId, taskKey, 'linux')).toEqual([
      path.join(roots.worktreesRoot, relative),
    ]);
    expect(acceptedCandidatePaths({ candidatesRoot: '/rt/checkout/merge-candidates.noindex', runtimeDirectory: '/rt/checkout' }, 's', 'c', 'darwin'))
      .toEqual(['/rt/checkout/merge-candidates.noindex/scope-s/candidate-c', '/rt/checkout/merge-candidates/scope-s/candidate-c']);
  });

  it('no Windows a worktree de produção cabe no teto do Git; o layout antigo não cabia', () => {
    const location = { runtimeDirectory, baseDirectory };
    const compact = path.join(
      managedWorktreesRoot(location, 'win32'),
      managedWorktreeRelativePath(projectId, checkoutId, taskKey, 'win32'),
    );
    const legacy = path.join(
      runtimeDirectory,
      'worktrees',
      managedWorktreeRelativePath(projectId, checkoutId, taskKey, 'darwin'),
    );
    expect(compact.length).toBeLessThanOrEqual(WINDOWS_GIT_WORKTREE_PATH_LIMIT);
    expect(legacy.length).toBeGreaterThan(WINDOWS_GIT_WORKTREE_PATH_LIMIT);
    const candidate = path.join(
      managedCandidatesRoot(location, 'win32'),
      managedCandidateRelativePath('s'.repeat(64), 'c'.repeat(64), 'win32'),
    );
    expect(candidate.length).toBeLessThanOrEqual(WINDOWS_GIT_WORKTREE_PATH_LIMIT);
  });

  it('no Windows separa checkouts e tasks e ainda aceita o registro antigo', () => {
    const other = managedWorktreeRelativePath(projectId, `${checkoutId}-2`, taskKey, 'win32');
    const current = managedWorktreeRelativePath(projectId, checkoutId, taskKey, 'win32');
    expect(other).not.toBe(current);
    expect(managedWorktreeRelativePath(projectId, checkoutId, worktreeTaskKey('space-b', 'tab'), 'win32'))
      .not.toBe(current);
    expect(acceptedWorktreeRelativePaths(projectId, checkoutId, taskKey, 'win32')).toEqual([
      current,
      managedWorktreeRelativePath(projectId, checkoutId, taskKey, 'linux'),
    ]);
  });

  it('aceita o registro antigo só onde ele morava, nunca sob a raiz nova', () => {
    const roots = {
      worktreesRoot: managedWorktreesRoot({ runtimeDirectory, baseDirectory }, 'win32'),
      legacyWorktreesRoot: legacyWorktreesRoot(runtimeDirectory),
    };
    const legacyRelative = managedWorktreeRelativePath(projectId, checkoutId, taskKey, 'linux');
    const accepted = acceptedWorktreePaths(roots, projectId, checkoutId, taskKey, 'win32');
    expect(accepted).toEqual([
      path.join(roots.worktreesRoot, managedWorktreeRelativePath(projectId, checkoutId, taskKey, 'win32')),
      path.join(roots.legacyWorktreesRoot, legacyRelative),
    ]);
    expect(accepted).not.toContain(path.join(roots.worktreesRoot, legacyRelative));
    // Fora do Windows só existe um caminho: o histórico, sob a raiz atual.
    const posixRoot = legacyWorktreesRoot('/rt/checkout');
    expect(acceptedWorktreePaths({ worktreesRoot: posixRoot, legacyWorktreesRoot: posixRoot }, projectId, checkoutId, taskKey, 'darwin'))
      .toEqual([path.join(posixRoot, legacyRelative)]);
  });
});
