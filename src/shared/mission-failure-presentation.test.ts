import { describe, expect, it } from 'vitest';
import {
  hasMissionFailureNotes,
  presentMissionFailure,
} from './mission-failure-presentation';

/**
 * Real-world description shape captured from a production runtime.sqlite3
 * (mission blocked by a merge-queue cascade + failed recovery preflight).
 */
const REAL_DESCRIPTION = [
  'analise no nexus. do disparo de panes de como ele esta se comprtando do',
  'que precisamos melhorar no sistema',
  '',
  '[NEXUS_TASK_DISPATCH_BLOCKED]',
  '## Worker bloqueado',
  '[NEXUS_FAILURE:terminal] Falha terminal de merge: merge diferido 12 vezes',
  'consecutivas sem progresso (último motivo: merge queue is blocked: sensors',
  'or review rejected the candidate checkout). O coordenador bloqueou a task',
  'para encerrar o retry silencioso; verifique o worktree e o handoff físico',
  'e replaneje a missão. A integração não foi aceita e exige revisão',
  'explícita. Clique em "Retomar missão" para revisar a tarefa e escolher a',
  'próxima ação.',
  '',
  '<!-- nexus:orchestrator-bootstrap-blocked -->',
  '## Orquestrador não iniciado',
  'O plano main-owned não pôde ser selado antes de iniciar qualquer provider.',
  'mission task plan is sealed after the first worktree allocation',
  'CTA: Recuperação automática.',
].join('\n');

describe('presentMissionFailure', () => {
  it('returns plain descriptions untouched with no sections', () => {
    const result = presentMissionFailure('Melhorar o onboarding do app');
    expect(result.summary).toBe('Melhorar o onboarding do app');
    expect(result.sections).toHaveLength(0);
    expect(result.headline).toBeNull();
    expect(hasMissionFailureNotes('Melhorar o onboarding do app')).toBe(false);
  });

  it('splits the operator goal from appended technical notes', () => {
    const result = presentMissionFailure(REAL_DESCRIPTION);
    expect(result.summary).toBe(
      'analise no nexus. do disparo de panes de como ele esta se comprtando ' +
        'do\nque precisamos melhorar no sistema',
    );
    expect(hasMissionFailureNotes(REAL_DESCRIPTION)).toBe(true);
  });

  it('parses readable sections and strips markers, tokens and CTA tails', () => {
    const { sections } = presentMissionFailure(REAL_DESCRIPTION);
    expect(sections.map((section) => section.title)).toEqual([
      'Worker bloqueado',
      'Orquestrador não iniciado',
    ]);
    const worker = sections[0]!.body;
    expect(worker).toContain('Falha terminal de merge');
    expect(worker).toContain('merge diferido 12 vezes');
    expect(worker).not.toContain('[NEXUS_FAILURE:terminal]');
    expect(worker).not.toContain('[NEXUS_TASK_DISPATCH_BLOCKED]');
    const bootstrap = sections[1]!.body;
    expect(bootstrap).toContain('não pôde ser selado');
    expect(bootstrap).not.toContain('<!--');
    expect(bootstrap).not.toContain('CTA:');
  });

  it('produces a compact headline from the first section', () => {
    const { headline } = presentMissionFailure(REAL_DESCRIPTION);
    expect(headline).toBeTruthy();
    expect(headline).toContain('Falha terminal de merge');
    expect(headline!.length).toBeLessThanOrEqual(200);
  });

  it('handles guided-plan block notes without headings', () => {
    const description =
      'corrija o login\n\n<!-- nexus:guided-plan-block -->\n' +
      '## Execução não iniciada\nO Nexus não conseguiu selar uma tarefa ' +
      'segura antes de abrir qualquer CLI. CTA: Recuperação automática.';
    const result = presentMissionFailure(description);
    expect(result.summary).toBe('corrija o login');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.title).toBe('Execução não iniciada');
    expect(result.sections[0]!.body).not.toContain('CTA:');
  });
});
