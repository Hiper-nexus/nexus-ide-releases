import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsyncGitRunner } from '../../runtime/git-command';
import { testProjectScope } from '../../orch/__tests__/scope-fixture';
import type { BusinessModelExtraction, ExtractBusinessModelOptions } from './business-model-extract';
import {
  __resetBusinessModelEnsureForTests,
  ensureBusinessModel,
} from './business-model-ensure';
import { configureBusinessModelStore } from './business-model-store';
import { createBarbershopRepo } from './__fixtures__/barbershop';

const HEAD = 'a'.repeat(40);
let root = '';
let storeDir = '';
const scope = testProjectScope({ rootRealPath: '/repo' });
type ExtractMock = (
  root: string,
  options?: ExtractBusinessModelOptions,
) => Promise<BusinessModelExtraction | null>;

/** Git runner fake: rev-parse responde HEAD; o resto falha fechado. */
function fakeGit(headSha: string | null = HEAD): AsyncGitRunner {
  return {
    run: async (_cwd: string, args: readonly string[]) => {
      if (args.includes('rev-parse')) {
        return headSha
          ? { status: 0, stdout: `${headSha}\n`, stderr: '' }
          : { status: 128, stdout: '', stderr: 'no HEAD' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function fakeExtraction(fingerprint = 'fp'): BusinessModelExtraction {
  return Object.freeze({
    fingerprint,
    document: Object.freeze({
      schemaVersion: 1 as const,
      flows: Object.freeze([]),
      invariants: Object.freeze([
        Object.freeze({
          id: 'projeto#1',
          fluxo: 'projeto',
          regra: 'sempre rode os testes',
          origem: 'AGENTS.md:2',
          arquivos: Object.freeze(['AGENTS.md']),
          tabelas: Object.freeze([]),
          funcoes: Object.freeze([]),
          testes: Object.freeze([]),
        }),
      ]),
    }),
    proposal: Object.freeze({
      targetPath: '.context/docs/business-model.md',
      content: '# doc',
      sources: Object.freeze([]),
      rationale: 'teste',
    }),
    pendingSources: Object.freeze([]),
    hurdles: Object.freeze([
      Object.freeze({
        id: 'hurdle:1',
        titulo: 'armadilha',
        resumo: 'resumo',
        origem: 'docs/AGENTS-HURDLES.md:1',
      }),
    ]),
  }) as BusinessModelExtraction;
}

beforeEach(() => {
  __resetBusinessModelEnsureForTests();
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bm-ensure-store-'));
  configureBusinessModelStore(storeDir);
});

afterEach(() => {
  configureBusinessModelStore(null);
  __resetBusinessModelEnsureForTests();
  fs.rmSync(storeDir, { recursive: true, force: true });
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
    root = '';
  }
});

describe('ensureBusinessModel', () => {
  it('extrai do HEAD e persiste no store na primeira chamada', async () => {
    const extract = vi.fn<ExtractMock>(async () => fakeExtraction());
    const record = await ensureBusinessModel(scope, { git: fakeGit(), extract });
    expect(record).not.toBeNull();
    expect(record!.headSha).toBe(HEAD);
    expect(record!.document.invariants[0]!.regra).toBe('sempre rode os testes');
    expect(record!.hurdles).toHaveLength(1);
    expect(extract).toHaveBeenCalledTimes(1);
    // Modo head: a extração NUNCA roda no worktree sujo.
    expect(extract.mock.calls[0][1]).toMatchObject({ source: 'head' });
  });

  it('segunda chamada no mesmo HEAD lê do store (sem re-extrair)', async () => {
    const extract = vi.fn(async () => fakeExtraction());
    await ensureBusinessModel(scope, { git: fakeGit(), extract });
    const again = await ensureBusinessModel(scope, { git: fakeGit(), extract });
    expect(again).not.toBeNull();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('HEAD novo → re-extrai (o modelo é por commit)', async () => {
    const extract = vi.fn(async () => fakeExtraction());
    const now = 1_000_000;
    await ensureBusinessModel(scope, { git: fakeGit(HEAD), extract, now: () => now });
    // Depois do TTL do cache de HEAD, o rev-parse roda de novo e acha o commit novo.
    await ensureBusinessModel(scope, {
      git: fakeGit('b'.repeat(40)),
      extract,
      now: () => now + 31_000,
    });
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('dedup: chamadas concorrentes dividem UMA extração', async () => {
    let release!: (value: BusinessModelExtraction | null) => void;
    const extract = vi.fn(
      () => new Promise<BusinessModelExtraction | null>((resolve) => (release = resolve)),
    );
    const first = ensureBusinessModel(scope, { git: fakeGit(), extract });
    const second = ensureBusinessModel(scope, { git: fakeGit(), extract });
    // O extract só é chamado depois dos awaits de HEAD/store — esperar o voo.
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    release(fakeExtraction());
    const [a, b] = await Promise.all([first, second]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('wait:false dispara em background e devolve null sem esperar', async () => {
    let done = false;
    const extract = vi.fn(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      done = true;
      return fakeExtraction();
    });
    const immediate = await ensureBusinessModel(scope, {
      git: fakeGit(),
      extract,
      wait: false,
    });
    expect(immediate).toBeNull();
    expect(extract).toHaveBeenCalledTimes(1);
    // O flight terminou sozinho em background.
    await vi.waitFor(() => expect(done).toBe(true));
    // E gravou: a próxima leitura acha pronto.
    const record = await ensureBusinessModel(scope, { git: fakeGit(), extract });
    expect(record).not.toBeNull();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('sem HEAD (repo sem commit / sem git) → null, sem extrair', async () => {
    const extract = vi.fn(async () => fakeExtraction());
    expect(await ensureBusinessModel(scope, { git: fakeGit(null), extract })).toBeNull();
    expect(extract).not.toHaveBeenCalled();
  });

  it('extração null ou que lança → null (fail-open), e retry não fica preso', async () => {
    const extract = vi.fn(async () => null);
    expect(await ensureBusinessModel(scope, { git: fakeGit(), extract })).toBeNull();
    const throwing = vi.fn(async () => {
      throw new Error('git morreu');
    });
    expect(await ensureBusinessModel(scope, { git: fakeGit(), extract: throwing })).toBeNull();
    // O flight falho saiu do mapa: a próxima chamada tenta de novo.
    const extract2 = vi.fn(async () => fakeExtraction());
    const record = await ensureBusinessModel(scope, { git: fakeGit(), extract: extract2 });
    expect(record).not.toBeNull();
  });

  it('headSha cacheado por 30s evita rev-parse repetido', async () => {
    const git = fakeGit();
    const spy = vi.fn(git.run);
    const cachedGit: AsyncGitRunner = { run: spy };
    const extract = vi.fn(async () => fakeExtraction());
    const now = 1_000_000;
    await ensureBusinessModel(scope, { git: cachedGit, extract, now: () => now });
    await ensureBusinessModel(scope, { git: cachedGit, extract, now: () => now + 1_000 });
    const revParses = spy.mock.calls.filter(([, args]) => args.includes('rev-parse'));
    expect(revParses).toHaveLength(1);
  });
});

describe('ensureBusinessModel real (extração de verdade sobre git)', () => {
  it('modelo do HEAD mesmo com AGENTS.md sujo — e pendingSources vazio', async () => {
    root = createBarbershopRepo();
    // Sujar a fonte que no modo worktree adiaria o modelo.
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\n- regra nova não commitada\n');
    const realScope = testProjectScope({ rootRealPath: root });
    const record = await ensureBusinessModel(realScope);
    expect(record).not.toBeNull();
    expect(record!.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(record!.document.flows.map((flow) => flow.fluxo)).toContain('close_commanda');
    // A regra suja NÃO entra: o modelo é do HEAD.
    expect(
      record!.document.invariants.some((invariant) =>
        invariant.regra.includes('regra nova não commitada'),
      ),
    ).toBe(false);
  });
});
