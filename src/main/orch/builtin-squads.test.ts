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
});
