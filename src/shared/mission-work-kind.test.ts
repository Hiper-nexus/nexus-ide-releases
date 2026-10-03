import { describe, expect, it } from 'vitest';
import {
  MIN_CLASSIFIABLE_GOAL_CHARS,
  WORK_KINDS,
  WORK_KIND_PRECEDENCE,
  classifyWorkKind,
  decideDesignAuthority,
  isUiMissionText,
  isWorkKind,
  requiresDesignAuthority,
} from './mission-work-kind';

describe('classifyWorkKind — honesty (unknown beats guessing)', () => {
  it.each([
    '',
    '   ',
    '\n\t ',
    'oi',
    'bug',
    'faz aí',
    'ok',
  ])('returns unknown for the empty/short goal %j', (goal) => {
    const verdict = classifyWorkKind(goal);
    expect(verdict.kind).toBe('unknown');
    expect(verdict.confidence).toBe('low');
    expect(verdict.signals).toEqual([]);
  });

  it.each([
    // There is no 'test' work kind yet — admitting that beats guessing feature.
    'escrever testes para o carrinho de compras',
    // A DATA pipeline is not ops work: only CI/CD/release pipelines are.
    'rodar o pipeline de dados do mês passado e comparar',
    'me ajuda com aquilo que a gente conversou ontem',
    'review the numbers from last quarter with the team',
  ])('returns unknown when nothing in the vocabulary matches %j', (goal) => {
    expect(classifyWorkKind(goal)).toMatchObject({
      kind: 'unknown',
      confidence: 'low',
      signals: [],
    });
  });

  it('never returns unknown with a non-empty signal list', () => {
    const verdict = classifyWorkKind('me ajuda com aquilo de ontem por favor');
    expect(verdict.kind).toBe('unknown');
    expect(verdict.signals).toEqual([]);
    expect(verdict.reason).toMatch(/nenhum sinal/i);
  });

  it('exposes the minimum classifiable size used by the product', () => {
    expect(MIN_CLASSIFIABLE_GOAL_CHARS).toBe(8);
  });
});

describe('classifyWorkKind — bug (pt-BR and English)', () => {
  it.each([
    'corrigir o bug do login',
    'consertar o erro 500 no checkout',
    'resolver a falha de sincronização do worktree',
    'o app trava ao abrir a missão, precisa arrumar isso',
    'a missão está quebrada depois do merge, corrija',
    'fix the crash on startup',
    'the sync worker throws an exception, please fix it',
    'there is a memory leak in the pane renderer, fix it',
  ])('classifies %j as bug', (goal) => {
    expect(classifyWorkKind(goal).kind).toBe('bug');
  });

  it('is high confidence when a defect noun meets a repair verb', () => {
    const verdict = classifyWorkKind('corrigir o bug do login');
    expect(verdict).toMatchObject({ kind: 'bug', confidence: 'high' });
    expect(verdict.signals.some((s) => s.rule === 'bug.defect')).toBe(true);
  });

  it.each([
    'fix the login flow',
    'arrumar o fluxo de cobrança recorrente',
    'tem um bug no login que ninguém olhou',
  ])('is low confidence when only a weak repair signal exists: %j', (goal) => {
    const verdict = classifyWorkKind(goal);
    expect(verdict.kind).toBe('bug');
    expect(verdict.confidence).toBe('low');
  });
});

describe('classifyWorkKind — feature (pt-BR and English)', () => {
  it.each([
    'implementar login com Google',
    'criar o endpoint de cobrança recorrente',
    'nova funcionalidade de exportar CSV do histórico',
    'adicionar suporte a webhooks no orquestrador',
    'add support for webhooks in the orchestrator',
    'build a new export pipeline for mission receipts',
  ])('classifies %j as feature', (goal) => {
    expect(classifyWorkKind(goal).kind).toBe('feature');
  });

  it('reports the creation signal that fired', () => {
    const verdict = classifyWorkKind('implementar login com Google');
    expect(verdict).toMatchObject({ kind: 'feature', confidence: 'high' });
    expect(verdict.signals.some((s) => s.rule === 'feature.create')).toBe(true);
  });
});

describe('classifyWorkKind — doc (pt-BR and English)', () => {
  it.each([
    'escrever o PRD da feature de cobrança',
    'documentar a arquitetura do orquestrador',
    'atualizar o README com as instruções de build',
    'write the ADR for the auth flow',
    'update the changelog for the release',
    'redigir o runbook de recuperação de missão',
  ])('classifies %j as doc', (goal) => {
    expect(classifyWorkKind(goal).kind).toBe('doc');
  });
});

describe('classifyWorkKind — visual (reuses the product UI vocabulary)', () => {
  it.each([
    'arrumar o visual do rail lateral',
    'nova tela de cobrança',
    'melhorar a acessibilidade do dashboard',
    'ajustar o layout do painel de agentes',
    'redesign the landing page',
    'gerar o sprite sheet do mascote',
    'fix the contrast of the dark mode theme',
  ])('classifies %j as visual', (goal) => {
    expect(classifyWorkKind(goal).kind).toBe('visual');
  });

  it('does not treat a repair verb over UI as a bug', () => {
    const verdict = classifyWorkKind('arrumar o visual do rail lateral');
    expect(verdict).toMatchObject({ kind: 'visual', confidence: 'high' });
  });

  it('is high confidence when a creation verb governs the surface', () => {
    expect(classifyWorkKind('make the sidebar collapsible')).toMatchObject({
      kind: 'visual',
      confidence: 'high',
    });
    expect(classifyWorkKind('criar a nova tela de cobrança')).toMatchObject({
      kind: 'visual',
      confidence: 'high',
    });
  });

  it.each([
    'melhorar a performance do dashboard',
    'traduzir a interface para inglês',
  ])(
    'drops to low confidence when the surface is only locative: %j',
    (goal) => {
      // The dashboard is WHERE the work happens, not WHAT the work is.
      expect(classifyWorkKind(goal)).toMatchObject({
        kind: 'visual',
        confidence: 'low',
      });
    },
  );

  it('prefers bug over a locative surface when a defect is reported', () => {
    const verdict = classifyWorkKind('o botão de aprovar não responde no macOS');
    expect(verdict).toMatchObject({ kind: 'bug', confidence: 'low' });
    expect(verdict.signals.some((s) => s.kind === 'visual')).toBe(true);
  });

  it('does not read the filler "make sure" as creation', () => {
    expect(classifyWorkKind('make sure the dashboard still loads')).toMatchObject(
      { kind: 'visual', confidence: 'low' },
    );
  });
});

describe('classifyWorkKind — documented boundaries (future work kinds)', () => {
  it.each([
    'refatorar o orquestrador para suportar squads paralelos',
    'refactor the pane store',
    'atualizar as dependências do projeto',
    'update dependencies to latest',
    'remover código morto do módulo de vault',
  ])(
    'returns unknown for %j — refactor/chore have no kind yet, and guessing is worse',
    (goal) => {
      expect(classifyWorkKind(goal).kind).toBe('unknown');
    },
  );
});

describe('classifyWorkKind — ops', () => {
  it.each([
    'configurar o backup do servidor de staging',
    'renovar o certificado SSL do domínio',
    'set up the CI pipeline for the repo',
    'fazer o deploy da v2 e acompanhar o rollback',
    'configurar o cron de monitoramento',
  ])('classifies %j as ops', (goal) => {
    expect(classifyWorkKind(goal).kind).toBe('ops');
  });
});

describe('classifyWorkKind — precedence table', () => {
  it('documents the precedence order machine-readably', () => {
    expect(WORK_KIND_PRECEDENCE).toEqual([
      'bug',
      'doc',
      'visual',
      'ops',
      'feature',
    ]);
    expect(WORK_KINDS).toEqual([
      'bug',
      'feature',
      'doc',
      'visual',
      'ops',
      'unknown',
    ]);
  });

  it('doc beats feature: "escrever o PRD da feature X"', () => {
    const verdict = classifyWorkKind('escrever o PRD da feature de cobrança');
    expect(verdict).toMatchObject({ kind: 'doc', confidence: 'high' });
    expect(verdict.signals.some((s) => s.kind === 'feature')).toBe(true);
  });

  it('bug beats feature: "corrigir o bug que a feature introduziu"', () => {
    const verdict = classifyWorkKind(
      'corrigir o bug que a feature introduziu ontem',
    );
    expect(verdict).toMatchObject({ kind: 'bug', confidence: 'high' });
    expect(verdict.signals.some((s) => s.kind === 'feature')).toBe(true);
  });

  it('bug beats doc when a real repair is requested', () => {
    const verdict = classifyWorkKind(
      'corrigir o bug do login e atualizar o CHANGELOG',
    );
    expect(verdict).toMatchObject({ kind: 'bug', confidence: 'low' });
    expect(verdict.signals.map((s) => s.kind)).toContain('doc');
  });

  it('doc beats a bare bug mention: "documentar os bugs conhecidos"', () => {
    const verdict = classifyWorkKind('documentar os bugs conhecidos do rail');
    expect(verdict).toMatchObject({ kind: 'doc', confidence: 'high' });
    expect(verdict.signals.some((s) => s.kind === 'bug')).toBe(true);
  });

  it('bug beats visual when the UI is reported as defective', () => {
    const verdict = classifyWorkKind(
      'the login button is broken, please fix it',
    );
    expect(verdict).toMatchObject({ kind: 'bug', confidence: 'low' });
    expect(verdict.signals.some((s) => s.kind === 'visual')).toBe(true);
  });

  it('visual beats feature and keeps high confidence for new UI', () => {
    const verdict = classifyWorkKind('criar a nova tela de cobrança');
    expect(verdict).toMatchObject({ kind: 'visual', confidence: 'high' });
    expect(verdict.signals.some((s) => s.rule === 'feature.create')).toBe(
      false,
    );
  });

  it('visual beats ops when publishing a UI surface', () => {
    const verdict = classifyWorkKind('publicar a nova landing page');
    expect(verdict.kind).toBe('visual');
    expect(verdict.signals.some((s) => s.kind === 'ops')).toBe(true);
  });

  it('ops beats feature: "criar o pipeline de CI"', () => {
    const verdict = classifyWorkKind('criar o pipeline de CI do repositório');
    expect(verdict.kind).toBe('ops');
  });

  it('drops to low confidence when two kinds both fire strongly', () => {
    const verdict = classifyWorkKind(
      'criar a feature de cobrança e escrever o PRD dela',
    );
    expect(verdict).toMatchObject({ kind: 'doc', confidence: 'low' });
    expect(verdict.reason).toMatch(/precedencia|precedência/i);
  });
});

describe('classifyWorkKind — adversarial prose', () => {
  it.each([
    ['documentar os bugs conhecidos do rail', 'doc'],
    ['escrever o guia de troubleshooting dos erros de merge', 'doc'],
    ['relatório dos crashes da semana', 'doc'],
    ['criar a nova tela de cobrança', 'visual'],
    ['fix the crash on startup', 'bug'],
  ] as const)('classifies %j as %s', (goal, expected) => {
    expect(classifyWorkKind(goal).kind).toBe(expected);
  });

  it('is diacritic- and case-insensitive', () => {
    const withAccents = classifyWorkKind('Corrigir o BUG da MISSÃO travada');
    const without = classifyWorkKind('corrigir o bug da missao travada');
    expect(withAccents.kind).toBe(without.kind);
    expect(withAccents.confidence).toBe(without.confidence);
  });
});

describe('classifyWorkKind — purity and immutability', () => {
  it('is deterministic for the same input', () => {
    const goal = 'corrigir o bug do login e atualizar o CHANGELOG';
    expect(classifyWorkKind(goal)).toEqual(classifyWorkKind(goal));
  });

  it('freezes the verdict and its signals', () => {
    const verdict = classifyWorkKind('nova tela de cobrança');
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(Object.isFrozen(verdict.signals)).toBe(true);
    for (const signal of verdict.signals) {
      expect(Object.isFrozen(signal)).toBe(true);
    }
  });

  it('always reports every signal it saw, including the losers', () => {
    const verdict = classifyWorkKind(
      'corrigir o bug do login e atualizar o CHANGELOG',
    );
    const kinds = new Set(verdict.signals.map((s) => s.kind));
    expect(kinds.has('bug')).toBe(true);
    expect(kinds.has('doc')).toBe(true);
    for (const signal of verdict.signals) {
      expect(signal.match.length).toBeGreaterThan(0);
      expect(signal.rule).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });
});

describe('isWorkKind', () => {
  it.each(WORK_KINDS)('accepts %j', (kind) => {
    expect(isWorkKind(kind)).toBe(true);
  });

  it.each([null, undefined, 42, '', 'BUG', 'refactor', {}])(
    'rejects %j',
    (value) => {
      expect(isWorkKind(value)).toBe(false);
    },
  );
});

/**
 * ONE SOURCE OF TRUTH FOR "IS THIS UI WORK?" (C2, H3, L6).
 *
 * Four grammars used to answer this question and they disagreed in production.
 * These tests pin the two decisions the surviving grammar serves and the
 * relationship between them.
 */
describe('classifyWorkKind — the visual grammar is the shared one', () => {
  it.each([
    // [goal, kind, confidence, rule that must have fired]
    ['implementar o CRUD de usuários com paginação', 'feature', 'high', null],
    ['refatorar o core do serviço de pagamento', 'unknown', 'low', null],
    ['extrair o core da engine para um pacote', 'unknown', 'low', null],
    [
      'implementar o design pattern repository no backend',
      'feature',
      'high',
      null,
    ],
    ['implementar cache no serviço de imagens', 'feature', 'high', null],
    ['trocar a cor primária para verde', 'visual', 'low', 'visual.trait'],
    ['trocar as cores do tema', 'visual', 'high', 'visual.quorum'],
    ['redesenhar a tela de cobrança', 'visual', 'high', 'visual.craft'],
    ['criar a nova tela de cobrança', 'visual', 'high', 'visual.surface'],
    ['gerar o sprite sheet do mascote', 'visual', 'high', 'visual.asset'],
  ] as const)(
    'classifies %j as %s/%s',
    (goal, kind, confidence, rule) => {
      const verdict = classifyWorkKind(goal);
      expect({ kind: verdict.kind, confidence: verdict.confidence }).toEqual({
        kind,
        confidence,
      });
      if (rule) {
        expect(verdict.signals.map((s) => s.rule)).toContain(rule);
      }
    },
  );

  it.each([
    // H3, measured before the fix:
    //   visual/high  visual.craft:core     — "refatorar o core do serviço"
    //   visual/high  visual.craft:core     — "extrair o core da engine"
    //   visual/high  visual.craft:design   — "implementar o design pattern"
    //   visual/high  visual.craft:imagens  — "implementar cache no serviço de imagens"
    // Each of the four would have fabricated a DESIGN.md in a backend repo.
    'refatorar o core do serviço de pagamento',
    'extrair o core da engine para um pacote',
    'implementar o design pattern repository no backend',
    'implementar cache no serviço de imagens',
  ])('emits no visual signal at all for %j', (goal) => {
    expect(
      classifyWorkKind(goal).signals.filter((s) => s.kind === 'visual'),
    ).toEqual([]);
  });

  it('gives `cor` a signal where it used to give none', () => {
    // Measured before the fix: `unknown/low` with NO signals, because `cores?`
    // could not match the singular `cor`.
    const verdict = classifyWorkKind('trocar a cor primária para verde');
    expect(verdict.kind).toBe('visual');
    expect(verdict.signals.map((s) => `${s.rule}:${s.match}`)).toEqual([
      'visual.trait:cor',
    ]);
  });
});

describe('decideDesignAuthority — the design contract predicate', () => {
  it.each([
    'redesenhar a tela de cobrança',
    'trocar as cores do tema',
    'criar a nova tela de cobrança',
    'Criar landing page inspirada em https://stripe.com',
    'redesign the landing page',
    'add a dark mode toggle to the settings screen',
    'melhorar a acessibilidade do dashboard',
  ])('grants design authority to %j', (goal) => {
    expect(decideDesignAuthority(goal)).toMatchObject({
      required: true,
      refusal: null,
    });
  });

  it.each([
    ['implementar o CRUD de usuários com paginação', 'not-visual-work'],
    ['implement the CRUD of users with pagination', 'not-visual-work'],
    ['refatorar o core do serviço de pagamento', 'not-visual-work'],
    ['implementar o design pattern repository no backend', 'not-visual-work'],
    ['implementar cache no serviço de imagens', 'not-visual-work'],
    ['documentar o esquema de cores do log', 'not-visual-work'],
    ['corrigir o bug da tela de erro que trava o backend', 'not-visual-work'],
    // Visual, but only a hint: `dashboard` is WHERE the work happens.
    ['melhorar a performance do dashboard', 'low-confidence'],
    ['ajustar o dashboard', 'low-confidence'],
    ['trocar a cor primária para verde', 'low-confidence'],
    // Visual ASSET work: no interface for a token contract to govern.
    [
      'Criar desktop pet v2, avatar e spritesheet animada com QA visual',
      'asset-not-interface',
    ],
    ['gerar o sprite sheet do mascote', 'asset-not-interface'],
  ] as const)('refuses %j with %s', (goal, refusal) => {
    expect(decideDesignAuthority(goal)).toMatchObject({
      required: false,
      refusal,
    });
  });

  it('always carries the verdict that justified the decision', () => {
    const decision = decideDesignAuthority('melhorar a performance do dashboard');
    expect(decision.verdict.kind).toBe('visual');
    expect(decision.verdict.confidence).toBe('low');
    expect(decision.verdict.reason).toMatch(/fracos/i);
  });
});

/**
 * THE ORDERING INVARIANT between the two decisions. The skill grant is
 * generous (a false positive costs one unused skill); the design authority is
 * strict (a false positive writes a DESIGN.md into a backend repository). If
 * this ever inverts, some mission is being handed a design obligation nobody
 * even considered UI work.
 */
describe('design authority is strictly stricter than the skill grant', () => {
  const CORPUS = [
    'implementar o CRUD de usuários com paginação',
    'implement the CRUD of users with pagination',
    'refatorar o core do serviço de pagamento',
    'extrair o core da engine para um pacote',
    'implementar o design pattern repository no backend',
    'implementar cache no serviço de imagens',
    'trocar a cor primária para verde',
    'trocar as cores do tema',
    'redesenhar a tela de cobrança',
    'criar a nova tela de cobrança',
    'melhorar a performance do dashboard',
    'ajustar o dashboard',
    'Criar landing page inspirada em https://stripe.com',
    'redesign the landing page',
    'add a dark mode toggle to the settings screen',
    'melhorar a acessibilidade do dashboard',
    'documentar o esquema de cores do log',
    'corrigir o bug da tela de erro que trava o backend',
    'Criar desktop pet v2, avatar e spritesheet animada com QA visual',
    'gerar o sprite sheet do mascote',
    'configurar o backup do servidor de staging',
    'escrever o PRD da feature de cobrança',
    'fix the crash on startup',
  ] as const;

  it.each(CORPUS)(
    'design authority implies UI mission for %j',
    (goal) => {
      if (requiresDesignAuthority(goal)) {
        expect(isUiMissionText(goal)).toBe(true);
      }
    },
  );

  it('is a proper subset — some UI work deliberately gets no contract', () => {
    const uiWork = CORPUS.filter((goal) => isUiMissionText(goal));
    const authority = CORPUS.filter((goal) => requiresDesignAuthority(goal));
    expect(authority.length).toBeGreaterThan(0);
    expect(uiWork.length).toBeGreaterThan(authority.length);
  });
});

describe('verbo de retrabalho governa a superfície visual', () => {
  it('"refaça a tela" é missão de UI com autoridade de design', () => {
    // Sonda 23/08: nem CREATION_VERB nem REPAIR_VERB tinham "refaça", então
    // visual.surface ficava FRACO e a missão de UI mais óbvia saía com
    // confiança baixa — sem DESIGN.md.
    const v = classifyWorkKind(
      'refaça a tela de cadastro para ficar bonita e simples no celular',
    );
    expect(v.kind).toBe('visual');
    expect(v.confidence).toBe('high');
    expect(decideDesignAuthority(
      'refaça a tela de cadastro para ficar bonita e simples no celular',
    ).required).toBe(true);
  });

  it('traço visual + superfície formam quórum, como dois traços', () => {
    // "deixa a tela inicial mais bonita" é o jeito mais comum de quem não é
    // dev pedir UI: um traço ("bonita") e uma superfície ("tela"). Antes saía
    // fraco+fraco = confiança baixa, ou seja, sem DESIGN.md.
    for (const goal of [
      'melhore o layout da página de preços',
      'ajuste o espaçamento da tela de login',
      'deixa a tela inicial mais bonita',
    ]) {
      const verdict = classifyWorkKind(goal);
      expect(verdict.kind).toBe('visual');
      expect(verdict.confidence).toBe('high');
      expect(decideDesignAuthority(goal).required).toBe(true);
    }
  });

  it('superfície SEM traço continua locativa — não vira design', () => {
    // O invariante da casa: "a performance do dashboard" fala de performance,
    // não de aparência. Alargar o quórum não pode atropelar isso.
    const verdict = classifyWorkKind(
      'melhore a performance da consulta de pedidos',
    );
    expect(verdict.kind).not.toBe('visual');
    expect(
      decideDesignAuthority('melhorar a performance do dashboard').required,
    ).toBe(false);
  });
});

describe('classifyWorkKind — escopo de auditoria/inventário (F-772)', () => {
  it('auditoria que enumera possíveis defeitos NÃO é bug — é general', () => {
    // O achado da missão: "auditoria de uso" virava bug só por mencionar
    // erros — dentro de um inventário o defeito é o ACHADO esperado, não um
    // mau funcionamento relatado para consertar.
    for (const goal of [
      'auditoria de uso das contas e providers — aponte erros e desperdícios',
      'faça um inventário das configurações e liste os erros encontrados',
      'mapear os panes ativos e os travamentos recorrentes',
      'audit the checkout flow and list possible failures',
    ]) {
      const verdict = classifyWorkKind(goal);
      expect(verdict.kind, goal).not.toBe('bug');
    }
  });

  it('defeito relatado continua bug — mesmo dentro de uma trilha de auditoria', () => {
    // "Audite E CORRIJA" é ordem de reparo: o verbo forte decide, o escopo
    // de auditoria não abafa. E "audit log" é artefato, não escopo.
    expect(
      classifyWorkKind('audite o parser e corrija as falhas que encontrar')
        .kind,
    ).toBe('bug');
    expect(
      classifyWorkKind('o audit log mostra erros de escrita desde ontem')
        .kind,
    ).toBe('bug');
  });
});

/**
 * F-813 — o escopo de auditoria (F-772) abafava a menção de defeito sempre que
 * o texto trouxesse `inventário`/`auditoria`/`mapeamento`/`censo`/
 * `levantamento`, mesmo como substantivo de DOMÍNIO ("o inventário do estoque
 * trava ao abrir" virava `unknown`). Um verbo de falha claro não pode ser
 * anulado por uma palavra de domínio.
 */
describe('classifyWorkKind — palavra de domínio não anula verbo de falha (F-813)', () => {
  it.each([
    'o inventário do estoque trava ao abrir',
    'a auditoria de acesso trava quando o usuário clica em salvar',
    'o mapeamento de rotas não abre depois do login',
    'o censo de clientes não funciona no Safari',
    'a tela de levantamento de preços travou ontem',
    'the inventory page crashes on open',
    'the audit module hangs when exporting',
  ])('relato de falha com substantivo de domínio vira bug: %s', (goal) => {
    const verdict = classifyWorkKind(goal);
    expect(verdict.kind, goal).toBe('bug');
    expect(verdict.signals.some((signal) => signal.kind === 'bug')).toBe(true);
  });

  it('com verbo de reparo continua bug forte, como antes', () => {
    const verdict = classifyWorkKind('o inventário do estoque trava ao abrir, corrija');
    expect(verdict.kind).toBe('bug');
    expect(verdict.confidence).toBe('high');
  });

  it.each([
    'auditoria de uso das contas e providers — aponte erros e desperdícios',
    'faça um inventário das configurações e liste os erros encontrados',
    'mapear os panes ativos e os travamentos recorrentes',
    'audit the checkout flow and list possible failures',
    // A auditoria é a TAREFA (verbo): enumerar o que trava é o achado.
    'audite o checkout e liste onde ele trava',
    'audit the checkout flow and list where it hangs',
    'mapeie os módulos que travam ao abrir',
    // Substantivo de domínio + substantivo de defeito: não há verbo de falha.
    'faça um inventário dos erros do estoque',
    // `quebra` é substantivo de domínio ("quebra de estoque"), não verbo de falha.
    'auditoria da quebra de estoque e das falhas de contagem',
  ])('auditoria que enumera defeitos continua NÃO sendo bug (F-772): %s', (goal) => {
    expect(classifyWorkKind(goal).kind, goal).not.toBe('bug');
  });

  it('audit log segue sendo artefato, não escopo: defeito relatado é bug', () => {
    expect(classifyWorkKind('o audit log mostra erros de escrita desde ontem').kind).toBe('bug');
  });

  it('varredura linear (teto de 50 ms em 16 KB)', () => {
    const SIZE = 16_384;
    const inputs: Array<[string, string]> = [
      ['"inventario trava " repetido', 'inventario trava '.repeat(SIZE / 17)],
      ['"nao " repetido', 'nao '.repeat(SIZE / 4)],
      ['"nao" + espaços', `nao${' '.repeat(SIZE - 3)}`],
      ['"not " + espaços', `not${' '.repeat(SIZE - 3)}`],
      ['"audit " repetido', 'audit '.repeat(SIZE / 6)],
      ['"trav" repetido', 'trav'.repeat(SIZE / 4)],
      ['espaços', ' '.repeat(SIZE)],
    ];
    for (const [, text] of inputs) {
      classifyWorkKind(text);
      const startedAt = performance.now();
      classifyWorkKind(text);
      expect(performance.now() - startedAt).toBeLessThan(50);
    }
  });
});
