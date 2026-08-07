/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import { MissionClarifyCards } from './MissionClarifyCards';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mission(id: string, status: Mission['status'] = 'running'): Mission {
  return {
    id,
    title: `Missão ${id}`,
    description: '',
    status,
    milestones: [],
    learnings: '',
    orchestratorSessionId: `session-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

function question(
  id: string,
  missionId: string,
  deliveryState: Handoff['deliveryState'] = 'submitted',
): Handoff {
  return {
    id,
    missionId,
    sessionId: `session-${missionId}`,
    fromAgent: 'Orquestrador Nexus',
    status: 'progress',
    claimTrust: 'untrusted',
    summary: 'Pergunta ao operador',
    artifacts: [
      {
        kind: 'nexus-clarify-question',
        schemaVersion: 1,
        clarify: {
          question: 'Qual banco devemos usar?',
          chips: [
            { id: 'opt-1', label: 'Postgres' },
            { id: 'opt-2', label: 'SQLite' },
          ],
          allowFreeform: false,
        },
      },
    ],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState,
    createdAt: 2,
  };
}

function mount(element: React.ReactElement): {
  host: HTMLDivElement;
  root: Root;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

afterEach(() => {
  Reflect.deleteProperty(window, 'nexus');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('MissionClarifyCards', () => {
  it('shows actionable chips with a PT-BR continuation CTA', async () => {
    const answerClarify = vi.fn(async () => ({
      ok: true as const,
      questionId: 'question-a',
      handoffId: 'answer-a',
      answer: { kind: 'chip' as const, chipId: 'opt-2', value: 'SQLite' },
      deliveryState: 'submitted' as const,
      accepted: true,
      cta: 'Resposta entregue ao orquestrador.',
    }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: { answerClarify } },
    });
    const { host, root } = mount(
      <MissionClarifyCards
        missions={[mission('mission-a')]}
        handoffs={[question('question-a', 'mission-a')]}
      />,
    );

    expect(host.textContent).toContain('Decisão necessária');
    expect(host.textContent).toContain('Missão mission-a');
    expect(host.textContent).toContain('Qual banco devemos usar?');
    expect(host.textContent).toContain(
      'Escolha uma opção para a missão continuar.',
    );
    const sqlite = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'SQLite',
    );
    await act(async () => sqlite?.click());

    expect(answerClarify).toHaveBeenCalledWith({
      missionId: 'mission-a',
      questionId: 'question-a',
      answer: 'opt-2',
    });
    expect(host.textContent).toContain('Resposta entregue ao orquestrador.');
    act(() => root.unmount());
  });

  it('does not render consumed, answered, terminal or other-mission questions', () => {
    const answered: Handoff = {
      ...question('answer-a', 'mission-a'),
      sessionId: undefined,
      fromAgent: 'Operador Nexus',
      artifacts: [
        {
          kind: 'nexus-clarify-answer',
          schemaVersion: 1,
          questionId: 'question-a',
          answer: { kind: 'chip', chipId: 'opt-1', value: 'Postgres' },
        },
      ],
    };
    const { host, root } = mount(
      <MissionClarifyCards
        missions={[mission('mission-a'), mission('mission-b', 'done')]}
        handoffs={[
          question('question-a', 'mission-a'),
          answered,
          question('question-b', 'mission-b'),
          question('question-c', 'mission-c'),
          question('question-d', 'mission-a', 'consumed'),
          {
            ...question('question-forged', 'mission-a'),
            sessionId: 'worker-session',
            fromAgent: 'worker-a',
          },
        ]}
      />,
    );

    expect(host.textContent).toBe('');
    act(() => root.unmount());
  });

  // Invertido de propósito: card em missão bloqueada era um botão morto —
  // clarify-flow recusa a resposta fora de 'running'.
  it('não mostra pergunta de missão bloqueada — o main recusaria a resposta', () => {
    const { host, root } = mount(
      <MissionClarifyCards
        missions={[mission('mission-blocked', 'blocked')]}
        handoffs={[question('question-blocked', 'mission-blocked')]}
      />,
    );

    expect(host.textContent).not.toContain('Missão mission-blocked');
    expect(host.textContent).not.toContain('Qual banco devemos usar?');
    // Nenhum chip: o card inteiro some, não fica um botão órfão que falharia.
    expect(host.querySelectorAll('button')).toHaveLength(0);
    act(() => root.unmount());
  });

  it('keeps the decision visible and gives a recovery CTA when IPC fails', async () => {
    const answerClarify = vi.fn(async () => {
      throw new Error('renderer scope changed');
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: { answerClarify } },
    });
    const { host, root } = mount(
      <MissionClarifyCards
        missions={[mission('mission-a')]}
        handoffs={[question('question-a', 'mission-a')]}
      />,
    );
    const postgres = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Postgres',
    );
    await act(async () => postgres?.click());

    expect(host.textContent).toMatch(/não foi possível entregar/i);
    expect(host.textContent).toMatch(/reabra a missão e tente novamente/i);
    expect(host.textContent).toContain('Qual banco devemos usar?');
    act(() => root.unmount());
  });
});
