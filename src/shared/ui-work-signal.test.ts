import { describe, expect, it } from 'vitest';
import {
  UI_WORK_QUORUM,
  canonicalizeWorkText,
  collectUiWorkEvidence,
  collectVisualAssetEvidence,
  isUiWorkText,
  isVisualAssetText,
} from './ui-work-signal';

/**
 * This module replaced four independent grammars. These tests pin the exact
 * properties that made the four disagree, so a future edit that reintroduces a
 * private regex has to break a named invariant first.
 */

describe('canonicalizeWorkText', () => {
  it('strips diacritics, lowercases and collapses whitespace', () => {
    expect(canonicalizeWorkText('  Paginação   DA   Página ')).toBe(
      'paginacao da pagina',
    );
  });

  it('is idempotent, so double-canonicalizing a goal is safe', () => {
    const once = canonicalizeWorkText('Redesign da INTERFACE');
    expect(canonicalizeWorkText(once)).toBe(once);
  });
});

describe('C2 — the accent trap that made a backend CRUD a UI mission', () => {
  it.each([
    'implementar o CRUD de usuários com paginação',
    'ajustar a paginação da listagem de pedidos',
    'corrigir a paginação do relatório',
  ])('does not read `pagina` inside `paginação`: %j', (goal) => {
    // `ç` is not a `\w`, so an UNcanonicalized /\bpagina\b/ closed its word
    // boundary right there and matched. Canonicalizing first is the fix.
    expect(canonicalizeWorkText(goal)).toContain('paginacao');
    expect(isUiWorkText(goal)).toBe(false);
    expect(collectUiWorkEvidence(goal).matches).toEqual([]);
  });

  it('still recognizes a real page', () => {
    const evidence = collectUiWorkEvidence('criar a página de checkout');
    expect(evidence.matches.map((m) => m.rule)).toContain('ui.page');
  });
});

describe('H3 — `cor` vs `core`', () => {
  it('matches `cor` and `cores`, which `cores?` never did for `cor`', () => {
    for (const goal of ['trocar a cor primária', 'trocar as cores do tema']) {
      expect(
        collectUiWorkEvidence(goal).matches.map((m) => m.rule),
      ).toContain('ui.color');
    }
  });

  it.each([
    'refatorar o core do serviço de pagamento',
    'extrair o core da engine para um pacote',
    'mover o core da engine para um worker',
  ])('never matches the English `core`: %j', (goal) => {
    expect(collectUiWorkEvidence(goal).matches).toEqual([]);
  });

  it('keeps the English `color`/`colors`', () => {
    expect(
      collectUiWorkEvidence('fix the button colors').matches.map((m) => m.rule),
    ).toContain('ui.color');
  });
});

describe('H3 — `design pattern` is not visual design', () => {
  it.each([
    'implementar o design pattern repository no backend',
    'aplicar o design pattern observer no store',
    'revisar o design do schema de eventos',
    'discutir o design da api de missões',
    'rever o design de arquitetura do orquestrador',
  ])('returns the technical sense to the technical domain: %j', (goal) => {
    expect(
      collectUiWorkEvidence(goal).matches.map((m) => m.rule),
    ).not.toContain('ui.design');
  });

  it.each([
    'melhorar o design da tela de cobrança',
    'refazer o design do rail lateral',
  ])('still fires on visual design: %j', (goal) => {
    expect(collectUiWorkEvidence(goal).matches.map((m) => m.rule)).toContain(
      'ui.design',
    );
  });

  it('never reads `designer` as `design`', () => {
    expect(
      collectUiWorkEvidence('contratar um designer para o time').matches,
    ).toEqual([]);
  });
});

describe('two calibrated layers (never a flat list)', () => {
  it('exposes the quorum the product was calibrated on', () => {
    expect(UI_WORK_QUORUM).toBe(2);
  });

  it('a single self-evident term is enough', () => {
    const evidence = collectUiWorkEvidence('ajustar o CSS do composer');
    expect(evidence.matches).toHaveLength(1);
    expect(evidence.isUiWork).toBe(true);
  });

  it('one ambiguous term is NOT enough, two are', () => {
    const single = collectUiWorkEvidence('documentar o esquema de cores do log');
    expect(single.matches.filter((m) => !m.selfEvident)).toHaveLength(1);
    expect(single.isUiWork).toBe(false);

    const quorum = collectUiWorkEvidence('trocar as cores do tema');
    expect(quorum.matches.filter((m) => !m.selfEvident)).toHaveLength(2);
    expect(quorum.isUiWork).toBe(true);
  });

  it.each([
    // The exact false positives the quorum exists to prevent.
    'documentar o esquema de cores do log',
    'corrigir o bug da tela de erro que trava o backend',
    'implementar o tema do relatório mensal',
    'alinhar as expectativas do contrato com o time',
    'migrar o banco de dados e revisar o design do schema',
    'investigar por que o cron de billing para de rodar',
    'Rebuild electron packaging and fix mobile clients deploy',
  ])('stays quiet on calibrated non-visual prose: %j', (goal) => {
    expect(isUiWorkText(goal)).toBe(false);
  });

  it.each([
    'arrumar o visual do rail de missoes',
    'deixar a tela de missao mais bonita',
    'corrigir o alinhamento dos botoes',
    'trocar as cores do tema',
    'revisar a tipografia e o espaçamento do painel',
    'deixar o app responsivo no celular',
    'ajustar o dashboard',
    'melhorar a aparência da lista de tarefas',
    'Criar landing page inspirada em https://stripe.com',
    'redesign the landing page',
    'add a dark mode toggle to the settings screen',
    'fix the contrast of the primary buttons',
  ])('recognizes real UI work in pt-BR and English: %j', (goal) => {
    expect(isUiWorkText(goal)).toBe(true);
  });
});

describe('`visual` as a noun, never as an adjective', () => {
  it.each(['arrumar o visual do rail', 'mexer no visual da tela'])(
    'fires on the noun: %j',
    (goal) => {
      expect(
        collectUiWorkEvidence(goal).matches.map((m) => m.rule),
      ).toContain('ui.visual-noun');
    },
  );

  it.each([
    'Criar desktop pet v2, avatar e spritesheet animada com QA visual',
    'rodar regressao visual antes do release',
  ])(
    'stays quiet on the trailing adjective: %j',
    (goal) => {
      expect(
        collectUiWorkEvidence(goal).matches.map((m) => m.rule),
      ).not.toContain('ui.visual-noun');
    },
  );
});

describe('authority roles are strictly stricter than the skill grant', () => {
  it('marks locative nouns so a verb can gate them', () => {
    const evidence = collectUiWorkEvidence('melhorar a performance do dashboard');
    expect(evidence.locative?.rule).toBe('ui.dashboard');
    expect(evidence.craft).toBeNull();
    // Self-evident for the skill grant; still only a PLACE for the contract.
    expect(evidence.isUiWork).toBe(true);
  });

  it('keeps `aplicativo` and `inspirado em` out of the authority decision', () => {
    for (const goal of [
      'melhorar o aplicativo de cobrança',
      'implementar cache inspirado no redis',
    ]) {
      const evidence = collectUiWorkEvidence(goal);
      expect(evidence.isUiWork).toBe(true);
      expect(evidence.craft).toBeNull();
      expect(evidence.locative).toBeNull();
      expect(evidence.traits).toEqual([]);
      expect(evidence.matches.every((m) => m.authority === 'none')).toBe(true);
    }
  });
});

describe('visual ASSETS are a different concept, never fused with UI', () => {
  it.each([
    'gerar o sprite sheet do mascote',
    'Criar desktop pet v2, avatar e spritesheet animada com QA visual',
    'produzir a ilustração de abertura',
  ])('recognizes asset work: %j', (goal) => {
    expect(isVisualAssetText(goal)).toBe(true);
  });

  it('does not read an asset mission as an interface mission', () => {
    const goal = 'Criar desktop pet v2, avatar e spritesheet animada com QA visual';
    expect(isVisualAssetText(goal)).toBe(true);
    expect(isUiWorkText(goal)).toBe(false);
  });

  it('does not read a UI mission as an asset mission', () => {
    const goal = 'redesenhar a tela de cobrança com novo layout';
    expect(isUiWorkText(goal)).toBe(true);
    expect(isVisualAssetText(goal)).toBe(false);
  });

  it.each([
    // H3: a generic media noun alone used to make this a visual mission.
    'implementar cache no serviço de imagens',
    'otimizar o upload de fotos do usuário',
    'servir as imagens do CDN com etag',
  ])('needs a quorum for generic media nouns: %j', (goal) => {
    expect(collectVisualAssetEvidence(goal).matches).toHaveLength(1);
    expect(isVisualAssetText(goal)).toBe(false);
  });

  it('two generic media nouns do form an asset mission', () => {
    expect(isVisualAssetText('trocar o logo e os ícones do app')).toBe(true);
  });
});

describe('purity', () => {
  it('is deterministic and frozen', () => {
    const goal = 'redesenhar a tela de cobrança';
    expect(collectUiWorkEvidence(goal)).toEqual(collectUiWorkEvidence(goal));
    const evidence = collectUiWorkEvidence(goal);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.matches)).toBe(true);
  });

  it('returns no evidence for empty text', () => {
    for (const value of ['', '   ', '\n\t']) {
      expect(collectUiWorkEvidence(value).isUiWork).toBe(false);
      expect(collectVisualAssetEvidence(value).isVisualAsset).toBe(false);
    }
  });

  it('emits stable rule ids', () => {
    for (const match of collectUiWorkEvidence('redesign the dashboard page')
      .matches) {
      expect(match.rule).toMatch(/^ui\.[a-z-]+$/);
    }
    for (const match of collectVisualAssetEvidence('gerar o avatar').matches) {
      expect(match.rule).toMatch(/^asset\.[a-z-]+$/);
    }
  });
});
