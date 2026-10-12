// Derived from can1357/oh-my-pi@03c48d073 review pipeline (MIT)
import { describe, expect, it } from 'vitest';
import { agentCategorySchema, squadSchema } from '../../shared/orch-types';
import { BUILTIN_SQUADS } from './builtin-squads';
import { parseReviewFindings } from './review-findings';

describe('built-in squads (invariantes gerais)', () => {
  it('todos validam contra o squadSchema (limites de tamanho incluídos)', () => {
    for (const squad of BUILTIN_SQUADS) {
      const parsed = squadSchema.safeParse(squad);
      expect(parsed.success, `squad ${squad.id} inválido`).toBe(true);
    }
  });

  it('todo worker (não-orquestrador) tem allowedTools não-nulo', () => {
    // Regra canônica do withAllowlists (SEC#5): null = irrestrito só é
    // aceitável no orquestrador; workers persistidos precisam de allowlist
    // explícita para passar o fire-gate do wizard.
    for (const squad of BUILTIN_SQUADS) {
      for (const agent of squad.agents) {
        if (agent.category === 'orchestrator') continue;
        expect(
          agent.allowedTools,
          `${squad.id}/${agent.id} sem allowedTools`,
        ).not.toBeNull();
        expect(agent.allowedTools).toBeDefined();
      }
    }
  });

  it('toda categoria de agente é válida', () => {
    for (const squad of BUILTIN_SQUADS) {
      for (const agent of squad.agents) {
        expect(
          agentCategorySchema.safeParse(agent.category).success,
          `${squad.id}/${agent.id} categoria inválida: ${agent.category}`,
        ).toBe(true);
      }
    }
  });

  it('todo worker builtin usa a única rota governada desta release: Codex', () => {
    for (const squad of BUILTIN_SQUADS) {
      for (const agent of squad.agents) {
        if (agent.category === 'orchestrator') {
          expect(
            ['claude', 'codex'],
            `${squad.id}/${agent.id} usa Maestro não verificado`,
          ).toContain(agent.cli);
          continue;
        }
        expect(
          agent.cli,
          `${squad.id}/${agent.id} promete worker incompatível`,
        ).toBe('codex');
      }
      expect(squad.orchestratorInstructions).not.toMatch(
        /adapterId\s*=\s*(?:kimi|grok|agy|opencode|claude)|cli\s*=\s*(?:kimi|grok|agy|opencode)/i,
      );
    }
  });

  it('encadeia plan → execução sem escrever fora da lane nem repetir planejamento', () => {
    const planning = BUILTIN_SQUADS.find(
      (squad) => squad.id === 'nexus-plan',
    );
    const delivery = BUILTIN_SQUADS.find(
      (squad) => squad.id === 'nexus-story-impl',
    );

    expect(planning?.orchestratorInstructions).toContain('docs/plan.md');
    expect(planning?.orchestratorInstructions).toContain(
      'Nesta lane escreva somente docs/plan.md',
    );
    expect(planning?.orchestratorInstructions).toMatch(
      /apenas pelo Maestro/i,
    );
    expect(planning?.orchestratorInstructions).toMatch(
      /NÃO use nexus_pane_spawn nem nexus_route_task/i,
    );
    expect(planning?.agents).toHaveLength(1);
    expect(planning?.agents[0]?.category).toBe('orchestrator');
    expect(planning?.agents[0]?.cli).toBe('claude');
    expect(
      delivery?.agents.filter((agent) => agent.category === 'orchestrator'),
    ).toEqual([
      expect.objectContaining({ agentName: 'Maestro', cli: 'claude' }),
    ]);
    expect(
      delivery?.agents
        .filter((agent) => agent.category !== 'orchestrator')
        .map((agent) => agent.cli),
    ).toEqual(['codex', 'codex', 'codex']);
    expect(
      delivery?.agents.some(
        (agent) =>
          agent.category !== 'orchestrator' &&
          ['claude', 'grok', 'kimi', 'agy', 'opencode'].includes(
            agent.cli,
          ),
      ),
    ).toBe(false);
    expect(delivery?.orchestratorInstructions).toMatch(
      /materialize dele o documento final/i,
    );
    expect(delivery?.orchestratorInstructions).toMatch(
      /plano não estiver materializado.*payload promovido.*materialize-o primeiro/is,
    );
    expect(delivery?.orchestratorInstructions).toMatch(
      /nunca repita planejamento/i,
    );
  });

  it('todo agente builtin declara allowedSkills (indefinido = zero skills no modo governed)', () => {
    // governed-cli-profile trata allowedSkills ausente como [] e o
    // skill-mirror não materializa nada: um roster builtin sem allowedSkills
    // roda sem NENHUMA skill em máquina limpa/endurecida.
    for (const squad of BUILTIN_SQUADS) {
      for (const agent of squad.agents) {
        expect(
          agent.allowedSkills,
          `${squad.id}/${agent.id} sem allowedSkills`,
        ).toBeDefined();
      }
    }
  });

  it('entrega superpowers a quem escreve/valida o plano e a mais ninguém', () => {
    const planning = BUILTIN_SQUADS.find((squad) => squad.id === 'nexus-plan');
    const delivery = BUILTIN_SQUADS.find(
      (squad) => squad.id === 'nexus-story-impl',
    );
    const superpowersOwners = BUILTIN_SQUADS.flatMap((squad) =>
      squad.agents
        .filter((agent) => agent.allowedSkills?.includes('superpowers'))
        .map((agent) => `${squad.id}/${agent.id}`),
    );
    const bmadOwners = BUILTIN_SQUADS.flatMap((squad) =>
      squad.agents
        .filter((agent) => agent.allowedSkills?.includes('bmad-templates'))
        .map((agent) => `${squad.id}/${agent.id}`),
    );

    expect(planning?.agents[0]?.allowedSkills).toContain('superpowers');
    expect(
      delivery?.agents.find((agent) => agent.id === 'qa')?.allowedSkills,
    ).toContain('superpowers');
    expect(
      delivery?.agents.find((agent) => agent.id === 'dev')?.allowedSkills,
    ).not.toContain('superpowers');
    expect(superpowersOwners).toEqual([
      // Architects já recebiam o vocabulário (regra pré-existente da política).
      'outcome-landing-page/ux-content',
      'nexus-research/architect',
      // Donos explícitos de documento de plano.
      'nexus-plan/orch',
      'nexus-story-impl/orch',
      'nexus-story-impl/qa',
      'kimi-code-cell/planner',
    ]);
    // BMAD saiu do padrão: nenhum builtin concede mais bmad-templates.
    expect(bmadOwners).toEqual([]);
  });

  it('preserva allowedSkills explícito dos rosters que já declaravam política', () => {
    const review = BUILTIN_SQUADS.find((squad) => squad.id === 'review-p0p3');
    const petStudio = BUILTIN_SQUADS.find(
      (squad) => squad.id === 'nexus-pet-studio',
    );

    expect(
      review?.agents
        .filter((agent) => agent.category === 'reviewer')
        .map((agent) => agent.allowedSkills),
    ).toEqual([[], [], [], []]);
    expect(petStudio?.agents[0]?.allowedSkills).toEqual(['nexus-pet-studio']);
  });

  it('kimi-code-cell keeps the Kimi method but uses governed Codex workers', () => {
    const squad = BUILTIN_SQUADS.find((entry) => entry.id === 'kimi-code-cell');
    expect(squad).toBeDefined();
    expect(squad?.builtin).toBe(true);
    expect(squad?.name).toBe('Code Cell — método Kimi');
    expect(squad?.orchestratorInstructions).toMatch(
      /Kimi continua disponível.*Terminal.*fora da execução autônoma/is,
    );
    const byId = Object.fromEntries(
      (squad?.agents ?? []).map((agent) => [agent.id, agent]),
    );
    expect(byId.explorer?.cli).toBe('codex');
    expect(byId.explorer?.category).toBe('scout');
    expect(byId.planner?.cli).toBe('codex');
    expect(byId.coder?.cli).toBe('codex');
    expect(byId.coder?.category).toBe('executor');
    expect(
      squad?.agents.some(
        (agent) =>
          agent.category !== 'orchestrator' && agent.cli !== 'codex',
      ),
    ).toBe(false);
  });
});

describe('built-in squads orientados a resultado', () => {
  const expectedPacks = [
    { id: 'outcome-landing-page', name: 'Landing Page' },
    { id: 'outcome-bug-fix', name: 'Bug Fix' },
    { id: 'outcome-store', name: 'Loja' },
  ] as const;

  it.each(expectedPacks)(
    '$name existe como builtin com contrato de resultado verificável',
    ({ id, name }) => {
      const squad = BUILTIN_SQUADS.find((entry) => entry.id === id);
      expect(squad).toBeDefined();
      expect(squad?.builtin).toBe(true);
      expect(squad?.name).toBe(name);
      expect(squad?.orchestratorInstructions).toContain(
        '## Contrato de resultado',
      );
      expect(squad?.orchestratorInstructions).toMatch(/crit[eé]rios de aceite/i);
      expect(squad?.orchestratorInstructions).toMatch(
        /handoff|evid[eê]ncia|prova/i,
      );
      expect(squad?.orchestratorInstructions).toMatch(
        /n[aã]o (?:marque|declare|conte).*(?:conclu[ií]d|done)/i,
      );
    },
  );

  it.each(expectedPacks)(
    '$name tem autoridade única, papéis independentes e revisão governada',
    ({ id }) => {
      const squad = BUILTIN_SQUADS.find((entry) => entry.id === id);
      const orchestrators =
        squad?.agents.filter((agent) => agent.category === 'orchestrator') ?? [];
      const workers =
        squad?.agents.filter((agent) => agent.category !== 'orchestrator') ?? [];

      expect(orchestrators).toHaveLength(1);
      expect(workers.length).toBeGreaterThanOrEqual(3);
      expect(new Set(workers.map((agent) => agent.id)).size).toBe(
        workers.length,
      );
      expect(workers.every((agent) => agent.cli === 'codex')).toBe(true);
      expect(
        workers.some((agent) => agent.category === 'reviewer'),
      ).toBe(true);

      for (const worker of workers) {
        expect(worker.allowedTools).not.toBeNull();
        expect(worker.allowedTools).toBeDefined();
      }
    },
  );

  it('Loja trata pagamentos, credenciais e dados de cliente como superfícies sensíveis', () => {
    const squad = BUILTIN_SQUADS.find((entry) => entry.id === 'outcome-store');
    expect(squad?.orchestratorInstructions).toMatch(/pagamento/i);
    expect(squad?.orchestratorInstructions).toMatch(/segredo|credencial/i);
    expect(squad?.orchestratorInstructions).toMatch(/dados (?:do )?cliente/i);
    expect(squad?.orchestratorInstructions).toMatch(
      /autoriza[cç][aã]o|confirma[cç][aã]o/i,
    );
  });
});

describe('built-in Review P0–P3 squad', () => {
  const squad = BUILTIN_SQUADS.find((entry) => entry.id === 'review-p0p3');

  it('existe como builtin com 1 orquestrador + reviewers read-only', () => {
    expect(squad).toBeDefined();
    expect(squad?.builtin).toBe(true);
    expect(squad?.name).toBe('Review P0–P3');

    const orchestrators = squad?.agents.filter(
      (agent) => agent.category === 'orchestrator',
    );
    expect(orchestrators).toHaveLength(1);

    const reviewers = squad?.agents.filter(
      (agent) => agent.category !== 'orchestrator',
    );
    expect(reviewers?.length).toBeGreaterThanOrEqual(1);
    for (const reviewer of reviewers ?? []) {
      expect(reviewer.category).toBe('reviewer');
      expect(reviewer.cli).toBe('codex');
    }
  });

  it('reviewers têm allowlists não-nulas e restritas a leitura+handoff', () => {
    const reviewers =
      squad?.agents.filter((agent) => agent.category === 'reviewer') ?? [];
    expect(reviewers.length).toBeGreaterThanOrEqual(1);
    for (const reviewer of reviewers) {
      expect(reviewer.allowedTools).not.toBeNull();
      expect(reviewer.allowedSkills).not.toBeNull();
      expect(reviewer.allowedSkills).toEqual([]);

      const tools = reviewer.allowedTools ?? [];
      expect(tools.length).toBeGreaterThan(0);
      // Nada de escrita, commit, spawn de panes ou controle de missão.
      for (const tool of tools) {
        expect(tool).not.toMatch(
          /write|commit|push|spawn|close|mission|editor|browser/,
        );
      }
      expect(tools).toContain('nexus_handoff_submit');
      expect(tools).toContain('nexus_git_diff');
      expect(tools).toContain('nexus_file_read');
    }
  });

  it('tem instruções substanciais para o orquestrador (guard anti-placeholder)', () => {
    // Não asseramos a PROSA do prompt (frágil a reescritas e não protege
    // comportamento) — só que existe conteúdo real, não um placeholder vazio.
    expect((squad?.orchestratorInstructions ?? '').length).toBeGreaterThan(400);
  });

  it('o contrato de saída do handoff é parseável por parseReviewFindings', () => {
    // O contrato REAL que o squad promete: um handoff no formato documentado
    // vira findings tipados com prioridade P0-P3. É isto que o consumidor
    // (UI/painel de handoffs) depende — não o texto exato do prompt. Se o
    // formato instruído divergir do parser, este teste quebra; reescritas de
    // prosa não.
    const handoffSummary = [
      'Revisão concluída.',
      '```json',
      JSON.stringify({
        verdict: 'incorrect',
        explanation: 'Um caminho de erro não é tratado.',
        confidence: 0.8,
        findings: [
          {
            title: 'Trata ENOENT em vez de engolir todo erro',
            body: 'O catch amplo esconde falhas reais.',
            priority: 'P1',
            confidence: 0.9,
            file: 'src/main/x.ts',
            lineStart: 40,
            lineEnd: 44,
          },
        ],
      }),
      '```',
    ].join('\n');

    const parsed = parseReviewFindings(handoffSummary);
    expect(parsed.verdict).toBe('incorrect');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.priority).toBe('P1');
    expect(parsed.findings[0]?.file).toBe('src/main/x.ts');
  });

  describe('presets qa-swarm e qa-vision (T4/T5)', () => {
    it('qa-swarm carrega com as 10 regras centrais e 6 agentes', () => {
      const squad = BUILTIN_SQUADS.find((s) => s.id === 'qa-swarm');
      expect(squad).toBeDefined();
      expect(squad?.name).toBe('QA Swarm');
      expect(squad?.agents).toHaveLength(6);
      expect(squad?.orchestratorInstructions).toContain('Cadeia de 3 níveis');
      expect(squad?.orchestratorInstructions).toContain('1:1:N');
      expect(squad?.orchestratorInstructions).toContain('Decision Gate');
      expect(squad?.orchestratorInstructions).toContain('END YOUR TURN');
      expect(squad?.orchestratorInstructions).toContain('Hard file-owner');
    });

    it('qa-vision carrega com o contrato F-XXX de 1 arquivo por bug', () => {
      const squad = BUILTIN_SQUADS.find((s) => s.id === 'qa-vision');
      expect(squad).toBeDefined();
      expect(squad?.name).toBe('QA Vision');
      expect(squad?.agents).toHaveLength(4);
      expect(squad?.orchestratorInstructions).toContain('1 bug = 1 arquivo docs/qa/items/F-XXX.md');
      expect(squad?.orchestratorInstructions).toContain('Faixas de ID por reviewer');
      expect(squad?.orchestratorInstructions).toContain('1 commit por finding');
    });

    it('F-1297: nativeInstructions de squad builtin não cita caminho resources/ do repositório', () => {
      for (const squad of BUILTIN_SQUADS) {
        expect(squad.nativeInstructions ?? '', squad.id).not.toMatch(/\bresources\/[a-z-]+\//);
      }
    });

    it('absurd-landing e cinema-site carregam com pipelines de design e mídia (T8)', () => {
      const landing = BUILTIN_SQUADS.find((s) => s.id === 'absurd-landing');
      expect(landing).toBeDefined();
      expect(landing?.name).toBe('Absurd Landing');
      expect(landing?.agents).toHaveLength(5);
      expect(landing?.orchestratorInstructions).toContain('UX & Content');
      expect(landing?.orchestratorInstructions).toContain('UI Design & Design System');

      const cinema = BUILTIN_SQUADS.find((s) => s.id === 'cinema-site');
      expect(cinema).toBeDefined();
      expect(cinema?.name).toBe('Cinema Site');
      expect(cinema?.agents).toHaveLength(5);
      expect(cinema?.orchestratorInstructions).toContain('Direção Criativa');
      expect(cinema?.orchestratorInstructions).toContain('Produção de Mídia');
    });
  });
});
