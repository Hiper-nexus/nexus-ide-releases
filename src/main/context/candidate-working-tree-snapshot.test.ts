import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProcessGitRunner } from '../runtime/git-command';
import { ensureMissionCodeCompletion } from '../orch/mission-code-completion';
import type { Mission } from '../../shared/orch-types';
import { captureWorkingTreeCandidate, readCandidateFile } from './candidate-working-tree-snapshot';

const roots: string[] = [];

function fixture(withGit = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-candidate-snapshot-')));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const value = 1;\n');
  const scope: ProjectExecutionScope = {
    version: 1, installationId: 'test', projectId: 'test', checkoutId: 'test',
    rootRealPath: root, identitySource: 'manifest',
  };
  const git = new ProcessGitRunner();
  const run = (...args: string[]) => git.run(root, args).stdout.trim();
  if (withGit) {
    run('init', '-q');
    run('config', 'user.name', 'Nexus Test');
    run('config', 'user.email', 'test@example.invalid');
    run('add', '--', 'app.ts');
    run('commit', '-qm', 'Fixture');
  }
  return { root, scope, run };
}

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('working-tree candidate snapshot', () => {
  it('captures the entire current state with HEAD when no historical baseline is proved', async () => {
    const { scope, root, run } = fixture(true);
    expect((await captureWorkingTreeCandidate({ scope })).changedPaths).toEqual([]);
    const before = run('status', '--porcelain');
    const full = await captureWorkingTreeCandidate({ scope, mode: 'current-state' });
    expect(full.changedPaths).toContain('app.ts');
    expect(full.headSha).toBe(run('rev-parse', 'HEAD'));
    expect(full.complete).toBe(true);
    expect(run('status', '--porcelain')).toBe(before);
    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('value = 1');
  });
  it('provides stable content fingerprints without Git and detects same-size edits', async () => {
    const { root, scope } = fixture();
    const first = await captureWorkingTreeCandidate({ scope });
    expect(first.source).toBe('filesystem');
    expect(first.complete).toBe(true);
    expect(first.headSha).toBeNull();
    expect((await captureWorkingTreeCandidate({ scope })).fingerprint).toBe(first.fingerprint);
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const value = 2;\n');
    expect((await captureWorkingTreeCandidate({ scope })).fingerprint).not.toBe(first.fingerprint);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('does not follow an untracked symlink or treat it as a complete candidate', async () => {
    const { root, scope } = fixture(true);
    fs.symlinkSync(path.join(root, 'app.ts'), path.join(root, 'alias.ts'));
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.incompleteReasons.some((reason) => reason.includes('alias.ts'))).toBe(true);
    expect(() => readCandidateFile(scope, 'alias.ts', 1024)).toThrow(/symbolic link/);
  });

  it('ignores runtime directories and secret basenames without reading their bodies', async () => {
    const { root, scope } = fixture();
    fs.mkdirSync(path.join(root, '.nexus'));
    fs.writeFileSync(path.join(root, '.nexus/runtime.json'), 'synthetic runtime state');
    fs.writeFileSync(path.join(root, '.env.ts'), 'synthetic private fixture');
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.changedPaths).toEqual(['app.ts']);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.excludedPaths).toContain('.env.ts');
    expect(snapshot.excludedPaths).toContain('.nexus/');
    expect(() => readCandidateFile(scope, '.env.ts', 1024)).toThrow('unsafe candidate source');
  });

  it('reports truncation instead of a complete fingerprint for oversized directory files', async () => {
    const { root, scope } = fixture();
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.incompleteReasons).toContain('filesystem candidate index was truncated');
  });

  it('falls back to file inspection instead of executing repository clean filters', async () => {
    const { root, scope, run } = fixture(true);
    run('config', 'filter.unsafe.clean', 'false');
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.ts filter=unsafe\n');
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.source).toBe('filesystem');
    expect(snapshot.complete).toBe(true);
    expect(snapshot.changedPaths).toContain('app.ts');
  });

  it('does not silently truncate a large Git candidate inventory', async () => {
    const { root, scope } = fixture(true);
    for (let index = 0; index < 513; index += 1) {
      fs.writeFileSync(path.join(root, `new-${index}.ts`), 'export const value = 1;\n');
    }
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.incompleteReasons).toContain('candidate file limit 512 reached');
    expect(snapshot.changedPaths).toHaveLength(512);
  });
});


describe('strict completion uses real Git inventory rather than orientation exclusions', () => {
  it.each(['build/task.js', 'vendor/source.c', '.claude/hooks/check.sh'])('tracked %s cannot become an empty non-code exemption', async file => {
    const { root, scope, run } = fixture(true);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'first implementation\n');
    run('add', '--force', '--', file); run('commit', '-qm', 'tracked candidate');
    const baseSha = run('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, file), 'changed implementation\n');
    const capture = () => captureWorkingTreeCandidate({ scope, baseSha });
    const candidate = await capture();
    const mechanical = vi.fn(async () => ({ kind: 'blocked' as const, description: 'review still required' }));
    const result = await ensureMissionCodeCompletion({ scope, executionScope: scope,
      mission: { id: 'candidate-test', title: 'Fix code', intentContract: { lane: 'standard' }, intentVersion: 1, updatedAt: 1 } as Mission,
      baselineSha: baseSha, authorSessionIds: [],
    }, { captureCandidate: capture, runMechanical: mechanical,
      ensureIndependentReview: async () => ({ kind: 'unavailable', reason: 'no independent review' }), assertCurrent: () => {} });
    expect(result.kind).toBe('blocked');
    expect(candidate.changedPaths).toContain(file);
    if (candidate.complete) expect(mechanical).toHaveBeenCalledOnce();
    else expect(candidate.incompleteReasons.length).toBeGreaterThan(0);
  });

  it.each(['build/task.js', 'vendor/source.c', '.claude/hooks/check.sh'])('records tracked deletion under excluded directory: %s', async file => {
    const { root, scope, run } = fixture(true);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'source\n');
    run('add', '--force', '--', file); run('commit', '-qm', 'tracked source');
    const baseSha = run('rev-parse', 'HEAD'); fs.unlinkSync(path.join(root, file));
    const candidate = await captureWorkingTreeCandidate({ scope, baseSha });
    expect(candidate.deletedPaths).toContain(file);
    expect(candidate.changedPaths).toContain(file);
    if (file.startsWith('.claude/')) expect(candidate.complete).toBe(false);
    else expect(candidate.complete).toBe(true);
  });

  it('current-state Git includes tracked build/vendor even when ignore rules match, and hashes their bytes', async () => {
    const { root, scope, run } = fixture(true);
    for (const file of ['build/task.js', 'vendor/source.c']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'first source\n');
    }
    fs.writeFileSync(path.join(root, '.gitignore'), 'build/\nvendor/\n');
    run('add', '--force', '--', '.gitignore', 'build/task.js', 'vendor/source.c'); run('commit', '-qm', 'ignored tracked sources');
    const first = await captureWorkingTreeCandidate({ scope, mode: 'current-state' });
    expect(first.complete).toBe(true);
    expect(first.changedPaths).toEqual(expect.arrayContaining(['build/task.js', 'vendor/source.c']));
    const file = path.join(root, 'build/task.js'); const stat = fs.statSync(file);
    fs.writeFileSync(file, 'other source\n'); fs.utimesSync(file, stat.atime, stat.mtime);
    const second = await captureWorkingTreeCandidate({ scope, mode: 'current-state' });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it.each(['.env.ts', '.codex/auth.json'])('tracked protected %s is incomplete without reading its diff/body', async file => {
    const { root, scope, run } = fixture(true);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'private-old-sentinel');
    run('add', '--force', '--', file); run('commit', '-qm', 'protected fixture');
    const baseSha = run('rev-parse', 'HEAD'); fs.writeFileSync(path.join(root, file), 'private-new-sentinel');
    for (const mode of ['delta', 'current-state'] as const) {
      const candidate = await captureWorkingTreeCandidate({ scope, baseSha, mode });
      expect(candidate.complete).toBe(false); expect(candidate.changedPaths).toContain(file);
      expect(JSON.stringify(candidate)).not.toContain('private-old-sentinel');
      expect(JSON.stringify(candidate)).not.toContain('private-new-sentinel');
    }
  });

  it('non-Git skipped dependencies and symlinks make partial coverage explicit', async () => {
    const { root, scope } = fixture();
    fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules/runtime.js'), 'do not read dependencies');
    fs.symlinkSync(path.join(root, 'app.ts'), path.join(root, 'alias.ts'));
    const candidate = await captureWorkingTreeCandidate({ scope });
    expect(candidate.complete).toBe(false);
    expect(candidate.excludedPaths).toContain('node_modules/');
    expect(candidate.incompleteReasons.some(reason => reason.includes('alias.ts'))).toBe(true);
  });
});


it('non-Git normal source remains inspectable beside dependencies/runtime, but excluded claimed artifacts block', async () => {
  const { root, scope } = fixture();
  for (const dir of ['node_modules', '.nexus', '.next', 'target', 'dist']) { fs.mkdirSync(path.join(root, dir)); fs.writeFileSync(path.join(root, dir, 'runtime.js'), 'not source coverage'); }
  fs.writeFileSync(path.join(root, '.env'), 'private-local-config');
  const candidate = await captureWorkingTreeCandidate({ scope, requiredPaths: ['app.ts'] });
  expect(candidate.complete).toBe(true);
  expect(candidate.changedPaths).toEqual(['app.ts']);
  expect(candidate.excludedPaths).toEqual(['.env', '.next/', '.nexus/', 'dist/', 'node_modules/', 'target/']);
  expect(JSON.stringify(candidate)).not.toContain('private-local-config');
  const outside = await captureWorkingTreeCandidate({ scope, requiredPaths: ['node_modules/runtime.js'] });
  expect(outside.complete).toBe(false);
  expect(outside.incompleteReasons.some(reason => reason.includes('not inspected'))).toBe(true);
});


it('non-Git build/vendor sources are hashed while dependency symlinks remain an explicit boundary', async () => {
  const { root, scope } = fixture();
  for (const file of ['build/task.js', 'vendor/source.c']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'source');
  }
  fs.symlinkSync(path.join(root, 'vendor'), path.join(root, 'node_modules'));
  const first = await captureWorkingTreeCandidate({ scope });
  expect(first.complete).toBe(true);
  expect(first.changedPaths).toEqual(['app.ts', 'build/task.js', 'vendor/source.c']);
  expect(first.excludedPaths).toContain('node_modules/');
  fs.writeFileSync(path.join(root, 'build/task.js'), 'edited');
  expect((await captureWorkingTreeCandidate({ scope })).fingerprint).not.toBe(first.fingerprint);
});


it('required unchanged tracked artifacts get byte coverage without inventing a delta', async () => {
  const { root, scope, run } = fixture(true);
  const baseSha = run('rev-parse', 'HEAD');
  const first = await captureWorkingTreeCandidate({ scope, baseSha, requiredPaths: ['app.ts'] });
  expect(first.complete).toBe(true); expect(first.changedPaths).toEqual([]); expect(first.coveredPaths).toEqual(['app.ts']);
  // A tracked artifact can have bytes hidden from diff by Git index metadata.
  run('update-index', '--assume-unchanged', '--', 'app.ts');
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const value = 2;\n');
  const second = await captureWorkingTreeCandidate({ scope, baseSha, requiredPaths: ['app.ts'] });
  expect(second.changedPaths).toEqual([]); expect(second.coveredPaths).toEqual(['app.ts']);
  expect(second.fingerprint).not.toBe(first.fingerprint);
});

it.each([false, true])('real Git unchanged required app still waits for independent review (README delta=%s)', async docsChange => {
  const { root, scope, run } = fixture(true);
  const baseSha = run('rev-parse', 'HEAD');
  if (docsChange) fs.writeFileSync(path.join(root, 'README.md'), '# Documentation update\n');
  const capture = () => captureWorkingTreeCandidate({ scope, baseSha, requiredPaths: ['app.ts'] });
  const review = vi.fn(async () => ({ kind: 'waiting' as const, reason: 'independent review still pending' }));
  const result = await ensureMissionCodeCompletion({ scope, executionScope: scope,
    mission: { id: 'required-app', title: 'Fix existing app.ts', intentContract: { lane: 'standard' }, intentVersion: 1, updatedAt: 1 } as Mission,
    baselineSha: baseSha, authorSessionIds: [],
  }, { captureCandidate: capture, runMechanical: async () => ({ kind: 'approved', evidenceId: 'mechanical', note: 'fixture checks',
    verification: { analysisComplete: true, headSha: baseSha, baseSha, checks: [], regression: null, regressionApplicable: false } }),
    ensureIndependentReview: review, assertCurrent: () => {} });
  expect(result.kind).toBe('waiting'); expect(review).toHaveBeenCalledOnce();
});

describe('F-1301: foreign untracked WIP that predates the mission baseline', () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
  const newest = (file: string) => { const stat = fs.lstatSync(file); return Math.max(stat.ctimeMs, stat.mtimeMs); };

  it('is not the mission delta: an oversized old video no longer blocks, new and re-touched files still count', async () => {
    const { root, scope, run } = fixture(true);
    const baseSha = run('rev-parse', 'HEAD');
    // Campo 12/10: 42 MB de video-presentation/ de outro agente, sem commit,
    // anteriores à missão — o candidato estourava o teto de 8 MB para sempre.
    const video = path.join(root, 'video-presentation', 'nexus-presentation.mp4');
    fs.mkdirSync(path.dirname(video), { recursive: true });
    fs.writeFileSync(video, Buffer.alloc(9 * 1024 * 1024, 1));
    fs.writeFileSync(path.join(root, 'old-notes.ts'), 'export const old = 1;\n');
    await settle();
    // Base observada 2 s (margem de relógio grosso) depois do WIP alheio.
    const since = Math.max(newest(video), newest(path.join(root, 'old-notes.ts'))) + 1 + 2_000;
    await settle();
    fs.writeFileSync(path.join(root, 'mission.ts'), 'export const mine = 1;\n');

    const blind = await captureWorkingTreeCandidate({ scope, baseSha });
    expect(blind.complete).toBe(false);
    expect(blind.incompleteReasons.join('\n')).toContain('video-presentation/nexus-presentation.mp4');

    const delta = await captureWorkingTreeCandidate({ scope, baseSha, untrackedSince: since });
    expect(delta.complete).toBe(true);
    expect(delta.changedPaths).toEqual(['mission.ts']);
    // Fora do delta, mas nomeados para o revisor — não misturados às exclusões de política.
    expect(delta.staleUntrackedPaths).toEqual(['old-notes.ts', 'video-presentation/nexus-presentation.mp4']);
    expect(delta.excludedPaths).toEqual([]);
    expect(delta.coveredPaths).not.toContain('video-presentation/nexus-presentation.mp4');

    // Entregável declarado continua lido mesmo sendo anterior à base.
    const required = await captureWorkingTreeCandidate({ scope, baseSha, untrackedSince: since, requiredPaths: ['old-notes.ts'] });
    expect(required.complete).toBe(true);
    expect(required.coveredPaths).toContain('old-notes.ts');
    // Coberto não é "fora do candidato".
    expect(required.staleUntrackedPaths).toEqual(['video-presentation/nexus-presentation.mp4']);

    // Sem base explícita o recorte por data não vale.
    expect((await captureWorkingTreeCandidate({ scope, untrackedSince: since })).complete).toBe(false);

    // Tocado depois da base = volta ao delta (e muda a impressão digital).
    fs.appendFileSync(path.join(root, 'old-notes.ts'), 'export const edited = 2;\n');
    const touched = await captureWorkingTreeCandidate({ scope, baseSha, untrackedSince: since });
    expect(touched.changedPaths).toEqual(['mission.ts', 'old-notes.ts']);
    expect(touched.fingerprint).not.toBe(delta.fingerprint);

    // Revisão do estado atual não aceita o recorte por data.
    const full = await captureWorkingTreeCandidate({ scope, mode: 'current-state', untrackedSince: since });
    expect(full.changedPaths).toContain('video-presentation/nexus-presentation.mp4');
    expect(full.complete).toBe(false);
  });

  it('an old symlink never leaves the delta by date', async () => {
    const { root, scope, run } = fixture(true);
    const baseSha = run('rev-parse', 'HEAD');
    fs.symlinkSync('app.ts', path.join(root, 'old-link.ts'));
    await settle();
    const since = newest(path.join(root, 'old-link.ts')) + 1 + 2_000;
    const snapshot = await captureWorkingTreeCandidate({ scope, baseSha, untrackedSince: since });
    expect(snapshot.changedPaths).toEqual(['old-link.ts']);
    expect(snapshot.staleUntrackedPaths).toBeUndefined();
  });

  it('a file written within 2 s before the baseline still counts as mission work (coarse clocks)', async () => {
    const { root, scope, run } = fixture(true);
    const baseSha = run('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'edge.ts'), 'export const edge = 1;\n');
    const since = newest(path.join(root, 'edge.ts')) + 1_000;
    expect((await captureWorkingTreeCandidate({ scope, baseSha, untrackedSince: since })).changedPaths).toEqual(['edge.ts']);
  });

  it('a docs-only delta keeps its exemption and names the old untracked WIP left outside', async () => {
    const { scope, run } = fixture(true);
    const baseSha = run('rev-parse', 'HEAD');
    const snapshot = (stale: string[]) => ({
      source: 'git' as const, headSha: baseSha, fingerprint: 'f', changedPaths: ['README.md'], coveredPaths: ['README.md'],
      deletedPaths: [], untrackedPaths: ['README.md'], diff: '', complete: true, incompleteReasons: [],
      ...(stale.length ? { staleUntrackedPaths: stale } : {}),
    });
    const mission = { id: 'f1301-docs', title: 'Fix code', intentContract: { lane: 'standard' }, intentVersion: 1, updatedAt: 1 } as Mission;
    const mechanical = vi.fn(async () => { throw new Error('mechanical reached'); });
    const ports = (stale: string[]) => ({ captureCandidate: async () => snapshot(stale), runMechanical: mechanical,
      ensureIndependentReview: vi.fn(), assertCurrent: () => {} });
    const clean = await ensureMissionCodeCompletion({ scope, executionScope: scope, mission, baselineSha: baseSha, authorSessionIds: [] }, ports([]));
    expect(clean.kind).toBe('exempt');
    // Negar a isenção prenderia a missão de docs no pré-requisito de testes;
    // o WIP antigo fica nomeado na prova, nunca escondido.
    const named = await ensureMissionCodeCompletion({ scope, executionScope: scope, mission, baselineSha: baseSha, authorSessionIds: [] }, ports(['src/feature.ts']));
    expect(named.kind).toBe('exempt');
    expect('proof' in named ? named.proof.note : '').toContain('não revisados (não rastreados anteriores à base): src/feature.ts');
    expect('proof' in clean ? clean.proof.note : '').not.toContain('não revisados');
    expect(mechanical).not.toHaveBeenCalled();
  });

  it('the completion gate passes the baseline time only for a delta and names the blocking files', async () => {
    const { scope, run } = fixture(true);
    const baseSha = run('rev-parse', 'HEAD');
    const capture = vi.fn(async (_input: { untrackedSince?: number }) => ({
      source: 'git' as const, headSha: baseSha, fingerprint: 'f', changedPaths: [], deletedPaths: [], untrackedPaths: [], diff: '',
      complete: false, incompleteReasons: ['candidate file unavailable or outside limits: big.bin', 'b', 'c', 'd'],
    }));
    const mission = { id: 'f1301', title: 'Fix code', intentContract: { lane: 'standard' }, intentVersion: 1, updatedAt: 1 } as Mission;
    const ports = { captureCandidate: capture, runMechanical: vi.fn(), ensureIndependentReview: vi.fn(), assertCurrent: () => {} };
    const delta = await ensureMissionCodeCompletion({ scope, executionScope: scope, mission, baselineSha: baseSha,
      baselineObservedAt: 1_234, authorSessionIds: [] }, ports);
    expect(capture.mock.calls[0]![0].untrackedSince).toBe(1_234);
    expect(delta.kind).toBe('blocked');
    const reason = 'reason' in delta ? delta.reason : '';
    expect(reason).toContain('outside limits: big.bin');
    expect(reason).toContain('(+1)');
    await ensureMissionCodeCompletion({ scope, executionScope: scope, mission, baselineSha: null,
      baselineObservedAt: 1_234, authorSessionIds: [] }, ports);
    expect(capture.mock.calls[1]![0].untrackedSince).toBeUndefined();
  });
});
