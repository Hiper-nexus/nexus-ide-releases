// @vitest-environment node
import { describe, expect, it } from 'vitest';

/**
 * F-776 — o brief greenfield não escolhe stack, mas instrui o uso do
 * stack-advisor e o registro da decisão (sem autoridade nova nem UI nova).
 */
import {
  parseGuidedGreenfieldBrief,
  renderGuidedGreenfieldBrief,
} from './guided-greenfield-brief';

const INTENT = {
  goal: 'Uma lista de tarefas para a padaria',
  acceptanceCriteria: ['criar tarefa', 'marcar como feita'],
} as const;

describe('guided greenfield brief — stack-advisor (F-776)', () => {
  it('cita o stack-advisor como caminho de decisão de stack', () => {
    const brief = renderGuidedGreenfieldBrief({
      goal: INTENT.goal,
      acceptanceCriteria: [...INTENT.acceptanceCriteria],
    });
    expect(brief).toContain('stack-advisor');
  });

  it('continua sem selecionar stack (só instrui e registra)', () => {
    const brief = renderGuidedGreenfieldBrief({
      goal: INTENT.goal,
      acceptanceCriteria: [...INTENT.acceptanceCriteria],
    });
    expect(brief).not.toMatch(/linguagem escolhida|framework escolhido/i);
  });

  it('o brief com a instrução continua canônico (round-trip do parse)', () => {
    const brief = renderGuidedGreenfieldBrief({
      goal: INTENT.goal,
      acceptanceCriteria: [...INTENT.acceptanceCriteria],
    });
    const parsed = parseGuidedGreenfieldBrief(brief);
    expect(parsed).not.toBeNull();
    expect(parsed!.goal).toBe(INTENT.goal);
  });
});
