import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextDraftRecord } from '../context-draft-store';
import { testProjectScope } from '../../orch/__tests__/scope-fixture';
import {
  BUSINESS_MODEL_TARGET_PATH,
  invariantsTouchedBy,
  readBusinessModelInvariants,
} from './business-model-contract';
import {
  __clearBusinessModelExtractionCacheForTests,
  extractBusinessModel,
} from './business-model-extract';
import {
  BUSINESS_MODEL_EXTRACTOR,
  runBusinessModelBootstrap,
  type BusinessModelKnowledge,
} from './business-model-bootstrap';
import { createBarbershopRepo, git, writeFixtureFile } from './__fixtures__/barbershop';

const roots: string[] = [];

function repo(): string {
  const root = createBarbershopRepo();
  roots.push(root);
  return root;
}

function lineAt(root: string, origem: string): string {
  const [file, line] = [origem.replace(/:\d+$/, ''), Number(origem.split(':').at(-1))];
  return fs.readFileSync(path.join(root, file), 'utf8').split('\n')[line - 1] ?? '';
}

beforeEach(() => __clearBusinessModelExtractionCacheForTests());
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('extractBusinessModel', () => {
  it('liga comanda → comissão: tabelas, trigger acoplado, chamador, teste e regra do AGENTS.md', () => {
    const root = repo();
    const extraction = extractBusinessModel(root)!;
    const flow = extraction.document.flows.find((item) => item.fluxo === 'close_commanda')!;

    expect(flow.escreve).toEqual(['appointments', 'commission_entries']);
    expect(flow.funcoes).toEqual(['close_commanda', 'sync_commission_totals']);
    expect(flow.arquivos).toContain('src/commanda.ts');
    expect(flow.testes).toEqual(['tests/db/close-commanda.test.ts']);

    const rules = extraction.document.invariants.filter((item) => item.fluxo === 'close_commanda');
    expect(rules.map((item) => item.regra)).toEqual(expect.arrayContaining([
      'close_commanda recusa: comanda ja fechada: %',
      expect.stringContaining('dispara o trigger trg_commission_totals → sync_commission_totals'),
      "appointments: status text not null check (status in ('open', 'closed'))",
      'commission_entries: unique (appointment_id)',
      'Nunca grave commission_entries fora de close_commanda.',
    ]));
    // Regra dentro de bloco de código não é regra.
    expect(extraction.document.invariants.some((item) => item.regra.includes('bloco de código'))).toBe(false);
  });

  it('não inventa: toda regra cita arquivo:linha cuja linha contém a evidência', () => {
    const root = repo();
    const { document, proposal } = extractBusinessModel(root)!;
    for (const invariant of document.invariants) {
      const line = lineAt(root, invariant.origem).toLowerCase();
      expect(line, invariant.id).toMatch(/raise exception|check|unique|create trigger|nunca/);
    }
    const locators = proposal.sources.map((source) => source.locator);
    for (const invariant of document.invariants) {
      expect(locators).toContain(invariant.origem.replace(/:\d+$/, ''));
    }
    for (const source of proposal.sources) {
      const bytes = fs.readFileSync(path.join(root, source.locator));
      expect(source.sourceHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('ignora fonte com alteração local não commitada (o commit do .context exige fonte no HEAD)', () => {
    const root = repo();
    writeFixtureFile(
      root,
      'supabase/migrations/20260102000000_close_commanda.sql',
      'create or replace function public.close_commanda(p uuid) returns void as $$ begin update public.appointments set total = 0; end; $$;\n',
    );
    const extraction = extractBusinessModel(root)!;
    expect(extraction.document.flows.map((flow) => flow.fluxo)).not.toContain('close_commanda');
    expect(extraction.proposal.sources.map((source) => source.locator))
      .not.toContain('supabase/migrations/20260102000000_close_commanda.sql');
  });

  it('não re-extrai sem mudança de fonte e re-extrai quando um commit muda a migration', () => {
    const root = repo();
    const first = extractBusinessModel(root);
    expect(extractBusinessModel(root)).toBe(first);

    writeFixtureFile(root, 'supabase/migrations/20260103000000_guard.sql', [
      'create or replace function public.close_commanda(p_id uuid) returns void as $$',
      'begin',
      "  raise exception 'caixa do dia fechado';",
      '  update public.appointments set status = $q$closed$q$ where id = p_id;',
      'end;',
      '$$;',
      '',
    ].join('\n'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'guard');

    const second = extractBusinessModel(root)!;
    expect(second).not.toBe(first);
    expect(second.document.invariants.map((item) => item.regra))
      .toContain('close_commanda recusa: caixa do dia fechado');
  });

  it('sem git ou sem fonte de regra não propõe nada', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(repo()), 'nexus-bm-nogit-')));
    roots.push(root);
    expect(extractBusinessModel(root)).toBeNull();
  });
});

describe('contrato do portão de regressão', () => {
  it('lê invariantes estruturados do doc aplicado e filtra pelos arquivos alterados', () => {
    const root = repo();
    expect(readBusinessModelInvariants(root)).toEqual([]);
    writeFixtureFile(root, BUSINESS_MODEL_TARGET_PATH, extractBusinessModel(root)!.proposal.content);

    const invariants = readBusinessModelInvariants(root);
    const raise = invariants.find((item) => item.regra.startsWith('close_commanda recusa'))!;
    expect(raise).toEqual({
      id: 'close_commanda#1',
      fluxo: 'close_commanda',
      regra: 'close_commanda recusa: comanda ja fechada: %',
      origem: 'supabase/migrations/20260102000000_close_commanda.sql:5',
      arquivos: ['supabase/migrations/20260102000000_close_commanda.sql', 'src/commanda.ts'],
      tabelas: ['appointments', 'commission_entries'],
      funcoes: ['close_commanda', 'sync_commission_totals'],
      testes: ['tests/db/close-commanda.test.ts'],
    });

    const touched = invariantsTouchedBy(invariants, ['src/commanda.ts']);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((item) => item.fluxo === 'close_commanda')).toBe(true);
    expect(invariantsTouchedBy(invariants, ['README.md'])).toEqual([]);
  });

  it('doc escrito à mão (sem bloco estruturado) devolve lista vazia, sem lançar', () => {
    const root = repo();
    writeFixtureFile(root, BUSINESS_MODEL_TARGET_PATH, '# Business\nUsage billing.\n');
    expect(readBusinessModelInvariants(root)).toEqual([]);
  });
});

function fakeKnowledge(root: string) {
  const drafts = new Map<string, ContextDraftRecord>();
  let next = 0;
  const knowledge: BusinessModelKnowledge = {
    list: vi.fn(({ status } = {}) => [...drafts.values()].filter((item) => !status || item.status === status)),
    get: vi.fn((id: string) => drafts.get(id) ?? null),
    propose: vi.fn((input, author) => {
      const record = {
        id: `draft-${++next}`,
        missionId: input.missionId ?? null,
        targetPath: input.targetPath,
        content: input.content,
        contentHash: 'h',
        expectedTargetHash: input.expectedTargetHash ?? null,
        sources: input.sources,
        status: 'proposed',
        author,
        reviewer: null,
      } as unknown as ContextDraftRecord;
      drafts.set(record.id, record);
      return record;
    }),
    review: vi.fn((id, input) => {
      const current = drafts.get(id)!;
      // Mesma guarda do store: autor nunca se aprova.
      if (current.author.id === input.reviewer.id || current.author.sessionId === input.reviewer.sessionId) {
        throw new Error('self review');
      }
      const reviewed = {
        ...current,
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        reviewer: input.reviewer,
      } as ContextDraftRecord;
      drafts.set(id, reviewed);
      return reviewed;
    }),
    apply: vi.fn((id: string) => {
      const current = drafts.get(id)!;
      if (current.status !== 'approved') throw new Error('not approved');
      writeFixtureFile(root, current.targetPath, current.content);
      const applied = { ...current, status: 'applied' } as ContextDraftRecord;
      drafts.set(id, applied);
      return { draft: applied } as ReturnType<BusinessModelKnowledge['apply']>;
    }),
  };
  return knowledge;
}

describe('runBusinessModelBootstrap', () => {
  it('propõe como extrator Nexus, revisa por re-derivação com outra identidade e aplica; 2ª passada fica em dia', () => {
    const root = repo();
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    const knowledge = fakeKnowledge(root);
    const scope = testProjectScope({ rootRealPath: root });

    const first = runBusinessModelBootstrap({ scope, knowledge });
    expect(first.status).toBe('applied');
    expect(knowledge.propose).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: BUSINESS_MODEL_TARGET_PATH, expectedTargetHash: null }),
      BUSINESS_MODEL_EXTRACTOR,
    );
    expect(readBusinessModelInvariants(root).length).toBe(first.invariants);

    const second = runBusinessModelBootstrap({ scope, knowledge });
    expect(second.status).toBe('up-to-date');
    expect(knowledge.propose).toHaveBeenCalledTimes(1);
  });

  it('rejeita quando a re-derivação não reproduz os bytes', () => {
    const root = repo();
    const knowledge = fakeKnowledge(root);
    const real = extractBusinessModel(root)!;
    const result = runBusinessModelBootstrap({
      scope: testProjectScope({ rootRealPath: root }),
      knowledge,
      extract: (_root, options) => options.fresh
        ? { ...real, proposal: { ...real.proposal, content: `${real.proposal.content}\ninjetado\n` } }
        : real,
    });
    expect(result.status).toBe('rejected');
    expect(knowledge.apply).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, BUSINESS_MODEL_TARGET_PATH))).toBe(false);
  });

  it('não sobrescreve business-model.md escrito à mão, mas substitui o esqueleto do bootstrap antigo', () => {
    const root = repo();
    const scope = testProjectScope({ rootRealPath: root });
    writeFixtureFile(root, BUSINESS_MODEL_TARGET_PATH, '# Business\nRegras do dono.\n');
    expect(runBusinessModelBootstrap({ scope, knowledge: fakeKnowledge(root) }).status).toBe('skipped');

    const skeleton = '# Business model\n\n> Auto-proposed skeleton from orientation (abc).\n';
    writeFixtureFile(root, BUSINESS_MODEL_TARGET_PATH, skeleton);
    const knowledge = fakeKnowledge(root);
    expect(runBusinessModelBootstrap({ scope, knowledge }).status).toBe('applied');
    expect(knowledge.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTargetHash: createHash('sha256').update(skeleton).digest('hex'),
      }),
      BUSINESS_MODEL_EXTRACTOR,
    );
  });
});

describe('scheduleBusinessModelRefreshForWorkspace', () => {
  it('projeto sem .context/docs não é tocado nem agenda trabalho', async () => {
    const { scheduleBusinessModelRefreshForWorkspace } = await import('./business-model-refresh');
    const root = repo();
    vi.useFakeTimers();
    try {
      scheduleBusinessModelRefreshForWorkspace(root);
      expect(vi.getTimerCount()).toBe(0);
      fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
      scheduleBusinessModelRefreshForWorkspace(root);
      expect(vi.getTimerCount()).toBe(1);
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });
});
