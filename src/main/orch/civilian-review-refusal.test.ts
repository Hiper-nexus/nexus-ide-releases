import { describe, expect, it } from 'vitest';
import {
  clearCivilianReviewRefusal,
  isCivilianReviewRefusal,
  noteCivilianReviewRefusal,
} from './civilian-delivery-completion';

/**
 * Missão real 19/08: board 10/10 inflado + review_missing virou loop quente —
 * 500+ recusas de completeVerified em minutos, uma por tick do watcher.
 * A recusa por revisão abre UMA janela por missão: loga/spawna uma vez e
 * silencia até o cooldown.
 */
describe('recusa civil por revisão — janela única, nunca loop quente', () => {
  it('reconhece só recusas de revisão', () => {
    expect(
      isCivilianReviewRefusal(
        'review_missing: Falta revisão independente com evidência.',
      ),
    ).toBe(true);
    expect(
      isCivilianReviewRefusal('review_without_evidence: sem prova'),
    ).toBe(true);
    expect(isCivilianReviewRefusal('review_rejected: reprovada')).toBe(false);
    expect(isCivilianReviewRefusal('workspace path is invalid')).toBe(false);
  });

  it('primeira recusa abre a janela; repetição dentro do cooldown silencia', () => {
    clearCivilianReviewRefusal('mission-janela');
    expect(noteCivilianReviewRefusal('mission-janela', 1_000)).toBe(true);
    expect(noteCivilianReviewRefusal('mission-janela', 2_000)).toBe(false);
    expect(noteCivilianReviewRefusal('mission-janela', 59_000)).toBe(false);
    // Cooldown vencido: nova janela (revisor pode ter morrido sem entregar).
    expect(noteCivilianReviewRefusal('mission-janela', 61_001)).toBe(true);
  });

  it('missões diferentes têm janelas independentes', () => {
    clearCivilianReviewRefusal('mission-a');
    clearCivilianReviewRefusal('mission-b');
    expect(noteCivilianReviewRefusal('mission-a', 1_000)).toBe(true);
    expect(noteCivilianReviewRefusal('mission-b', 1_000)).toBe(true);
  });

  it('conclusão limpa a janela — próxima missão do mesmo id recomeça', () => {
    clearCivilianReviewRefusal('mission-limpa');
    expect(noteCivilianReviewRefusal('mission-limpa', 1_000)).toBe(true);
    clearCivilianReviewRefusal('mission-limpa');
    expect(noteCivilianReviewRefusal('mission-limpa', 2_000)).toBe(true);
  });
});

import { remintReviewerForSeat } from './civilian-delivery-completion';
import type { SquadAgent } from '../../shared/orch-types';

describe('remint do revisor sem credencial (reviewer:cursor-agent, 19/08)', () => {
  const reviewer = {
    id: 'rev',
    agentName: 'Revisor',
    category: 'reviewer',
    cli: 'cursor-agent',
  } as SquadAgent;

  it('reviewer sem auth present vira o primeiro CLI present da preferência', () => {
    const seated = remintReviewerForSeat(reviewer, (cli) => cli === 'codex');
    expect(seated.cli).toBe('codex');
    expect(seated.agentName).toBe('Revisor');
  });

  it('reviewer já present não é tocado', () => {
    const seated = remintReviewerForSeat(reviewer, () => true);
    expect(seated).toBe(reviewer);
  });

  it('sem candidato present mantém o original — falha visível no pane', () => {
    const seated = remintReviewerForSeat(reviewer, () => false);
    expect(seated.cli).toBe('cursor-agent');
  });
});

import { buildCivilianReviewerPrompt } from './civilian-delivery-completion';
import { storyConfirmationScript } from './mission-story-plan';

describe('prompt do revisor com "como confirmar" por story (overclick, 19/08)', () => {
  const mission = {
    title: 'HiperGO',
    description: 'Entregar 3 páginas do produto',
  };
  const agent = { agentName: 'Revisor' };
  const tasks = [
    { title: 'Implementar página de login', status: 'done' },
    { title: 'Criar API de sessão', status: 'done' },
  ] as const;

  it('inclui o board selado com o roteiro VERBATIM de cada story', () => {
    const prompt = buildCivilianReviewerPrompt(mission, agent, [...tasks]);
    expect(prompt).toContain('Board selado (2 stories)');
    for (const task of tasks) {
      expect(prompt).toContain(task.title);
      expect(prompt).toContain(storyConfirmationScript(task.title));
    }
    expect(prompt).toContain('Feito ≠ validado');
    expect(prompt).toContain('veredito POR STORY');
  });

  it('sem board selado degrada para o prompt de revisão simples', () => {
    const prompt = buildCivilianReviewerPrompt(mission, agent, []);
    expect(prompt).not.toContain('Board selado');
    expect(prompt).toContain('nexus_handoff_submit');
  });

  it('o roteiro é determinístico — selo e spawn geram o MESMO texto', () => {
    expect(storyConfirmationScript('  Implementar   login  ')).toBe(
      storyConfirmationScript('Implementar login'),
    );
    expect(storyConfirmationScript('Implementar login')).toContain(
      '"Implementar login"',
    );
  });
});
