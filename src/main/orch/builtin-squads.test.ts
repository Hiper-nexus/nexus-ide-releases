// Derived from can1357/oh-my-pi@03c48d073 review pipeline (MIT)
import { describe, expect, it } from 'vitest';
import { agentCategorySchema, squadSchema } from '../../shared/orch-types';
import { BUILTIN_SQUADS } from './builtin-squads';

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

  it('instruções portam o pipeline do omp: escopo, ruído, localidade, JSON', () => {
    const instructions = squad?.orchestratorInstructions ?? '';

    // Escopo do diff (uncommitted / branch / commit).
    expect(instructions).toContain('git diff --cached');
    expect(instructions).toContain('git show');

    // Lista literal de exclusão de ruído, com razões (EXCLUDED_PATTERNS).
    for (const marker of [
      'lock file',
      'minified',
      'generated',
      'snapshot',
      'source map',
      'build output',
      'vendor',
      'image',
      'font',
      'binary',
      'package-lock.json',
      'node_modules',
    ]) {
      expect(instructions, `exclusão ausente: ${marker}`).toContain(marker);
    }

    // Distribuição por localidade e delegação via tools do Nexus.
    expect(instructions).toContain('localidade');
    expect(instructions).toContain('nexus_pane_spawn');
    expect(instructions).toContain('nexus_task');
    expect(instructions).toContain('nexus_handoff_list');

    // Instruções do reviewer: prioridades, cross-boundary e read-only.
    expect(instructions).toContain('P0');
    expect(instructions).toContain('P3');
    expect(instructions).toContain('dispatch point');
    expect(instructions).toContain('READ-ONLY');

    // Contrato do handoff final: JSON tipado parseável.
    expect(instructions).toContain('```json');
    expect(instructions).toContain('"verdict"');
    expect(instructions).toContain('parseReviewFindings');

    // Squad de desenvolvimento comum → recebe a guidance genérica.
    expect(instructions).toContain('## Comunicação com o usuário');
  });
});
