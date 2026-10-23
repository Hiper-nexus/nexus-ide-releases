import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  JUDGE_FRONTIER_LANE,
  isFrontierReviewer,
  judgeSeatNeedsAccessProof,
  routeTask,
  informativeReviewSeat,
  securityCriticalGateJudge,
  type AdapterAvailability,
} from './task-router';
import {
  quarantineRejectedModel,
  resetModelAccessQuarantineForTests,
} from './model-access-quarantine';
import { PUBLISHED_BENCHMARKS } from './published-benchmarks';

// F-233 (regra do operador, 01/10): revisão/auditoria/veredito só com modelos
// de ponta — GLM/MiMo davam "veredito APROVAR" em revisão de código. A lane
// de julgamento reutiliza a mecânica da lane visual; sem assento disponível,
// `judgeUnavailable` devolve o julgamento ao Maestro.
const frontierAdapters: AdapterAvailability[] = [
  {
    id: 'claude',
    installed: true,
    models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  },
  {
    id: 'codex',
    installed: true,
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
  },
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  { id: 'mimo-code', installed: true, models: ['xiaomi/mimo-v2.6-flash'] },
];

const cheapAdapters: AdapterAvailability[] = [
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  { id: 'mimo-code', installed: true, models: ['xiaomi/mimo-v2.6-flash'] },
];

const ctx = () => ({ multiScore: false });

describe('lane de julgamento (F-233: só modelos de ponta julgam)', () => {
  it('revisão com claude reservado cai no Codex Sol 6.1 da lane', () => {
    const decision = routeTask(
      'Revisão de segurança do commit 464f658e',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      undefined,
      true, // claude reservado ao Maestro
      undefined,
      ctx(),
    );
    expect(decision).not.toBeNull();
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.model).toBe('gpt-6.1-sol');
    expect(decision!.reason).toContain('lane de julgamento');
    expect(decision!.judgeUnavailable).toBeUndefined();
  });

  it('sinal novo "auditoria" também entra na lane (somente leitura)', () => {
    const decision = routeTask(
      'Auditoria somente leitura do módulo de licença',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      undefined,
      true,
      undefined,
      ctx(),
    );
    expect(decision!.reason).toContain('lane de julgamento');
    // Mesma lane: com claude reservado, o primeiro assento livre é o Sol 6.1.
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.model).toBe('gpt-6.1-sol');
  });

  it('Fable lidera a lane quando o claude não está reservado', () => {
    const decision = routeTask(
      'Revise o diff do worker e dê o veredito',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      ctx(),
    );
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-fable-5-1');
    expect(decision!.reason).toContain('lane de julgamento');
  });

  it('sem nenhum frontier instalado: judgeUnavailable e o Maestro julga', () => {
    const decision = routeTask(
      'Revise o código do commit e aprove ou rejeite',
      cheapAdapters,
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      ctx(),
    );
    expect(decision).not.toBeNull();
    expect(['glm', 'mimo-code']).toContain(decision!.adapterId);
    expect(decision!.judgeUnavailable).toBe(true);
    expect(decision!.reason).toContain('sem juiz frontier');
    expect(decision!.reason).not.toContain('lane de julgamento');
  });

  it('menção explícita de modelo vence a lane de julgamento', () => {
    const decision = routeTask(
      'Revise o diff — julgue com o glm-5.3',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      ctx(),
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.model).toBe('glm-5.3');
    expect(decision!.reason).not.toContain('lane de julgamento');
  });

  it('lane lista exatamente os nove assentos de topo', () => {
    expect([...JUDGE_FRONTIER_LANE]).toEqual([
      { adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'max' },
      { adapterId: 'claude', model: 'claude-fable-5-1' },
      { adapterId: 'claude', model: 'claude-opus-5-5' },
      { adapterId: 'claude', model: 'claude-sonnet-5-5' },
      { adapterId: 'codex', model: 'gpt-6.1-sol' },
      { adapterId: 'codex', model: 'gpt-6-astra' },
      { adapterId: 'agy', model: 'gemini-4-argon' },
      { adapterId: 'grok', model: 'grok-4.7' },
      { adapterId: 'kimi', model: 'kimi-code/k3.1-pro' },
    ]);
  });

  it('F-779: todo assento de fora de Claude/Codex/Muse tem DeepSWE publicado ≥ o do Sonnet 5.5', () => {
    const floor = PUBLISHED_BENCHMARKS['claude:claude-sonnet-5-5']!.deepSWE!;
    for (const seat of JUDGE_FRONTIER_LANE) {
      if (['claude', 'codex', 'muse'].includes(seat.adapterId)) continue;
      expect(PUBLISHED_BENCHMARKS[`${seat.adapterId}:${seat.model}`]?.deepSWE, seat.model)
        .toBeGreaterThanOrEqual(floor);
    }
  });

  // F-779: com Claude e Codex já sentados na missão, a próxima revisão vai
  // para outro carro-chefe da lane em vez de repetir os mesmos dois.
  // F-817: o Argon só entra com PROVA de acesso (a CLI o anunciou: liveModels).
  const claudeCodexUsed = {
    multiScore: false,
    missionUseCounts: new Map([
      ['claude', 2],
      ['codex', 2],
    ]),
  };
  const reviewPool = (agy: Partial<AdapterAvailability> = {}): AdapterAvailability[] => [
    ...frontierAdapters,
    {
      id: 'agy',
      installed: true,
      models: ['gemini-4-argon', 'gemini-3.8-flash-high'],
      ...agy,
    },
    { id: 'grok', installed: true, models: ['grok-4.7'] },
  ];
  const REVIEW_TEXT = 'Revise o diff do worker e dê o veredito';

  it('revisão com claude e codex já usados vai para o Grok quando o Argon não tem prova de acesso', () => {
    const decision = routeTask(
      REVIEW_TEXT,
      reviewPool(),
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      claudeCodexUsed,
    );
    expect(decision!.reason).toContain('lane de julgamento');
    expect(`${decision!.adapterId}:${decision!.model}`).toBe('grok:grok-4.7');
  });

  it('com a CLI anunciando o Argon (prova), ele assume o assento livre antes do Grok', () => {
    const decision = routeTask(
      REVIEW_TEXT,
      reviewPool({ liveModels: ['gemini-4-argon', 'gemini-3.8-flash-high'] }),
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      claudeCodexUsed,
    );
    expect(decision!.reason).toContain('lane de julgamento');
    expect(`${decision!.adapterId}:${decision!.model}`).toBe('agy:gemini-4-argon');
  });

  describe('prova de acesso do Argon (F-817)', () => {
    afterEach(() => resetModelAccessQuarantineForTests());

    it('só conta como prova o que a CLI anunciou — o catálogo bundled não prova', () => {
      expect(judgeSeatNeedsAccessProof({ adapterId: 'agy', model: 'gemini-4-argon' })).toBe(true);
      expect(judgeSeatNeedsAccessProof({ adapterId: 'grok', model: 'grok-4.7' })).toBe(false);
      expect(judgeSeatNeedsAccessProof({ adapterId: 'claude', model: 'claude-fable-5-1' })).toBe(false);
      // liveModels de outro modelo do agy não prova o Argon.
      const decision = routeTask(
        REVIEW_TEXT,
        reviewPool({ liveModels: ['gemini-3.8-flash-high'] }),
        DEFAULT_ROUTING_TABLE,
        undefined,
        false,
        undefined,
        claudeCodexUsed,
      );
      expect(`${decision!.adapterId}:${decision!.model}`).toBe('grok:grok-4.7');
    });

    it('Argon anunciado mas em quarentena (F-683/F-520: a conta recusou) fica fora', () => {
      quarantineRejectedModel('agy', 'gemini-4-argon', 'Model access is disabled');
      const decision = routeTask(
        REVIEW_TEXT,
        reviewPool({ liveModels: ['gemini-4-argon', 'gemini-3.8-flash-high'] }),
        DEFAULT_ROUTING_TABLE,
        undefined,
        false,
        undefined,
        claudeCodexUsed,
      );
      expect(`${decision!.adapterId}:${decision!.model}`).toBe('grok:grok-4.7');
    });

    it('sem Claude/Codex/Grok, o Argon sem prova não vira juiz — o Maestro julga', () => {
      const decision = routeTask(
        REVIEW_TEXT,
        [
          { id: 'agy', installed: true, models: ['gemini-4-argon', 'gemini-3.8-flash-high'] },
          ...cheapAdapters,
        ],
        DEFAULT_ROUTING_TABLE,
        undefined,
        false,
        undefined,
        ctx(),
      );
      expect(decision!.judgeUnavailable).toBe(true);
      expect(decision!.model).not.toBe('gemini-4-argon');
    });

    it('sem Claude/Codex/Grok, o Argon COM prova é o juiz', () => {
      const decision = routeTask(
        REVIEW_TEXT,
        [
          {
            id: 'agy',
            installed: true,
            models: ['gemini-4-argon', 'gemini-3.8-flash-high'],
            liveModels: ['gemini-4-argon'],
          },
          ...cheapAdapters,
        ],
        DEFAULT_ROUTING_TABLE,
        undefined,
        false,
        undefined,
        ctx(),
      );
      expect(`${decision!.adapterId}:${decision!.model}`).toBe('agy:gemini-4-argon');
      expect(decision!.judgeUnavailable).toBeUndefined();
    });

    // 13/10: o AGY 1.3.4 lista o Argon só com sufixo de esforço
    // (gemini-4-argon-medium/-high/-low). A variante anunciada é a prova.
    it('AGY que lista só as variantes com sufixo: a variante anunciada assume o assento', () => {
      const argon = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low'];
      expect(judgeSeatNeedsAccessProof({ adapterId: 'agy', model: 'gemini-4-argon-high' })).toBe(true);
      const decision = routeTask(
        REVIEW_TEXT,
        reviewPool({
          models: [...argon, 'gemini-3.8-flash-high'],
          liveModels: [...argon, 'gemini-3.8-flash-high'],
        }),
        DEFAULT_ROUTING_TABLE,
        undefined,
        false,
        undefined,
        claudeCodexUsed,
      );
      expect(`${decision!.adapterId}:${decision!.model}`).toBe('agy:gemini-4-argon-medium');
    });
  });

  describe('auditoria de segurança crítica (F-817)', () => {
    const SECURITY_AUDIT = 'auditar a segurança da autenticação';
    const everyone = reviewPool({ liveModels: ['gemini-4-argon', 'gemini-3.8-flash-high'] });

    it('continua com Claude/Codex mesmo com eles muito usados na missão e Argon/Grok livres', () => {
      const decision = routeTask(
        SECURITY_AUDIT,
        everyone,
        DEFAULT_ROUTING_TABLE,
        undefined,
        false,
        undefined,
        claudeCodexUsed,
      );
      expect(decision!.tier).toBe('critical');
      expect(['claude', 'codex']).toContain(decision!.adapterId);
      expect(decision!.reason).toContain('lane de julgamento');
      expect(decision!.reason).toContain('segurança crítica');
      // O mesmo texto sem o rótulo de segurança diversifica (F-779).
      const generic = routeTask(
        'revise o diff do worker (crítico) e dê o veredito',
        everyone,
        DEFAULT_ROUTING_TABLE,
        'critical',
        false,
        undefined,
        claudeCodexUsed,
      );
      expect(['agy', 'grok']).toContain(generic!.adapterId);
    });

    // F-1477 (fundador, 13/10: "cadê o uso do Kimi, do MiniMax, do Grok, do
    // Devin?"): "segurança", "migração" e "produção" fazem quase toda revisão
    // virar critical/security, e a trava do F-817 a prendia em Claude/Codex.
    // Revisão Codex: `readOnly` sozinho não prova nada (o juiz de portão também
    // é somente leitura). Só a revisão INFORMATIVA provada pelo Main no spawn
    // (`informativeReview`: somente leitura, sem worktree de escrita, fora dos
    // caminhos de juiz) usa a lane inteira, que espalha por uso na missão.
    const SECURITY_REVIEW = 'revisar somente leitura a segurança da migração para produção';
    const routeWith = (context: Record<string, unknown>) => routeTask(
      SECURITY_REVIEW,
      everyone,
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      { ...claudeCodexUsed, ...context },
    );

    it('F-1477 (1/3): revisão informativa somente leitura usa a lane completa e espalha', () => {
      const decision = routeWith({ readOnly: true, informativeReview: true });
      expect(decision!.tier).toBe('critical');
      expect(decision!.specialty).toBe('security');
      expect(decision!.reason).toContain('lane de julgamento (modelos de ponta)');
      expect(decision!.reason).not.toContain('segurança crítica: Claude/Codex');
      expect(['agy', 'grok']).toContain(decision!.adapterId);
    });

    it('F-1477 (2/3): juiz de portão (somente leitura, sem a prova informativa) continua Claude/Codex', () => {
      // nexus_route_task e o revisor da conclusão de código abrem juiz cujo
      // approve vira portão de integração: readOnly, mas nunca informativo.
      const decision = routeWith({ readOnly: true });
      expect(decision!.reason).toContain('lane de julgamento (segurança crítica: Claude/Codex)');
      expect(['claude', 'codex']).toContain(decision!.adapterId);
    });

    it('F-1477 (3/3): writer — sem readOnly ou readOnly com worktree de escrita — continua Claude/Codex', () => {
      // `spawnRouteAuthority` dá só `readOnly` ao readOnly+isolatedWriter (F-1318).
      for (const context of [{}, { readOnly: true, informativeReview: false }]) {
        const decision = routeWith(context);
        expect(decision!.reason).toContain('lane de julgamento (segurança crítica: Claude/Codex)');
        expect(['claude', 'codex']).toContain(decision!.adapterId);
      }
    });

    it('F-1477: informativeReviewSeat marca só o assento que saiu de Claude/Codex em segurança crítica', () => {
      const informative = routeWith({ readOnly: true, informativeReview: true });
      expect(informativeReviewSeat(informative!)).toBe(true);
      expect(informativeReviewSeat({ tier: 'critical', specialty: 'security', adapterId: 'claude' })).toBe(false);
      expect(informativeReviewSeat({ tier: 'critical', specialty: 'security', adapterId: 'codex' })).toBe(false);
      expect(informativeReviewSeat({ tier: 'hard', specialty: 'security', adapterId: 'grok' })).toBe(false);
      expect(informativeReviewSeat({ tier: 'critical', specialty: 'feature', adapterId: 'grok' })).toBe(false);
    });

    it('F-1477: o portão de integração só aceita Claude/Codex em missão de segurança crítica', () => {
      const missionGoal = 'Auditar a segurança da autenticação e dos tokens de produção';
      expect(securityCriticalGateJudge(missionGoal, 'claude')).toBe(true);
      expect(securityCriticalGateJudge(missionGoal, 'codex')).toBe(true);
      expect(securityCriticalGateJudge(missionGoal, 'grok')).toBe(false);
      expect(securityCriticalGateJudge(missionGoal, 'agy')).toBe(false);
      // Fora de segurança crítica o F-779 não muda: Argon/Grok aprovam.
      expect(securityCriticalGateJudge('Revisar o layout do kanban', 'grok')).toBe(true);
      expect(securityCriticalGateJudge('', 'grok')).toBe(true);
    });

    it('sem Claude/Codex instalados, Grok e Argon não recebem a auditoria: o Maestro julga', () => {
      const decision = routeTask(
        SECURITY_AUDIT,
        reviewPool({ liveModels: ['gemini-4-argon', 'gemini-3.8-flash-high'] }).filter(
          (a) => a.id !== 'claude' && a.id !== 'codex',
        ),
        DEFAULT_ROUTING_TABLE,
        undefined,
        false,
        undefined,
        ctx(),
      );
      expect(decision!.judgeUnavailable).toBe(true);
      expect(decision!.reason).toContain('sem juiz frontier');
      expect(['gemini-4-argon', 'grok-4.7']).not.toContain(decision!.model);
    });
  });

  // F-234 é identidade, não candidatura: a prova de acesso do F-817 vale só
  // para a ROTA; o revisor que de fato rodou (modelo da sessão) segue aceito.
  it('portão F-234 aceita os carros-chefe novos e continua recusando GLM/MiMo', () => {
    expect(isFrontierReviewer('agy', 'gemini-4-argon')).toBe(true);
    expect(isFrontierReviewer('agy', 'gemini-4-argon-high')).toBe(true);
    expect(isFrontierReviewer('agy', 'gemini-4-argon-low')).toBe(true);
    expect(isFrontierReviewer('grok', 'grok-4.7')).toBe(true);
    expect(isFrontierReviewer('glm', 'glm-5.3')).toBe(false);
    expect(isFrontierReviewer('mimo-code', 'xiaomi/mimo-v2.6-pro')).toBe(false);
    expect(isFrontierReviewer('agy', 'gemini-3.8-flash-high')).toBe(false);
  });
});
