/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterInfo } from '../../shared/types';
import type { Mission, Squad } from '../../shared/orch-types';
import { MissionWizardPlanReview } from './MissionWizardPlanReview';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const adapter: AdapterInfo = {
  id: 'codex',
  kind: 'cli-pty',
  label: 'Codex',
  icon: 'X',
  models: { list: ['gpt-worker'], default: 'gpt-worker' },
  installed: true,
  orchestratorCapable: true,
  installCommand: '',
  idleTimeoutMs: 1_000,
};

const squad: Squad = {
  id: 'outcome-bug-fix',
  name: 'Bug Fix',
  createdAt: '1',
  builtin: true,
  orchestratorInstructions: 'Review.',
  agents: [
    {
      id: 'orch',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'codex',
      model: 'gpt-worker',
    },
    {
      id: 'dev',
      agentName: 'Implementador',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-worker',
      allowedTools: [],
    },
  ],
};

const mission: Mission = {
  id: 'mission-1',
  title: 'Corrigir carrinho',
  description: 'Corrigir total duplicado no carrinho',
  status: 'pending',
  milestones: [],
  learnings: '',
  intentState: 'ready_to_start',
  intentVersion: 1,
  intentContract: {
    version: 1,
    source: 'typed',
    goal: 'Corrigir total duplicado no carrinho',
    acceptanceCriteria: ['Teste de regressão verde'],
    risk: 'normal',
    executionMode: 'assisted',
    lane: 'standard',
    contextPolicy: 'on-demand',
    intentVersion: 1,
    budgets: {
      planningTokens: 1_000,
      executionTokens: 10_000,
      maxWorkers: 2,
    },
  },
  createdAt: 1,
  updatedAt: 1,
};

describe('MissionWizardPlanReview', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows objective, waves, roster cost and honest P0–P3 status on one screen', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        model: {
          richMetadata: vi.fn(async () => ({
            id: 'gpt-worker',
            catalogProvider: 'fixture',
            cost: { input: 1, output: 8 },
          })),
        },
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <MissionWizardPlanReview
          mission={mission}
          squad={squad}
          roster={squad.agents}
          adapters={[adapter]}
          error={null}
          spawning={false}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onStart={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain('REVISÃO DA MISSÃO');
    expect(host.textContent).toContain('Corrigir total duplicado no carrinho');
    expect(host.textContent).toMatch(/Ondas previstas/i);
    expect(host.textContent).toMatch(/até 2 especialistas/i);
    expect(host.textContent).toMatch(/Custo estimado do time/i);
    expect(host.textContent).toMatch(/Agentes em paralelo:\s*2/i);
    expect(host.textContent).toContain('$1 entrada / $8 saída por 1M tokens');
    expect(host.textContent).toMatch(
      /Revisão técnica automática ao final/i,
    );
    expect(host.textContent).toContain('revisão independente');
    expect(host.textContent).toContain('validação final');
    expect(host.textContent).not.toContain('Workers simultâneos');
    expect(host.textContent).not.toContain('CUSTO ESTIMADO DO ROSTER');
    expect(host.textContent).not.toContain('PREVC');
    expect(host.querySelectorAll('.wizard__plan-card > h3')).toHaveLength(4);
    expect(host.textContent).toContain('Ainda não confirmado');
    expect(host.textContent).toContain(
      'Este envio aprova a missão exatamente como revisada acima.',
    );
    // O clique aprova E despacha na mesma ação (o grant do wizard suprime o
    // modal nativo), então o CTA nomeia o efeito real — não "enviar para
    // aprovação", que prometia uma segunda tela que não existe mais.
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === 'Iniciar missão',
      ),
    ).toBe(true);
    expect(host.textContent).not.toContain('Enviar para aprovação');
    expect(host.textContent).not.toContain('Confirmar e começar');

    act(() => root.unmount());
  });

  it('announces both invalid-contract and asynchronous launch errors', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <MissionWizardPlanReview
          mission={{ ...mission, intentContract: undefined }}
          squad={squad}
          roster={squad.agents}
          adapters={[adapter]}
          error={null}
          spawning={false}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onStart={vi.fn()}
        />,
      );
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'contrato de intenção válido',
    );

    await act(async () => {
      root.render(
        <MissionWizardPlanReview
          mission={mission}
          squad={squad}
          roster={squad.agents}
          adapters={[adapter]}
          error="O despacho falhou com segurança."
          spawning={false}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onStart={vi.fn()}
        />,
      );
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'O despacho falhou com segurança.',
    );

    act(() => root.unmount());
  });

  it('reviews a team roundtable without calling it an implementation', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const goal =
      'Teste de todos panes, cada um me fala o que faz na missão';
    const roundtableMission: Mission = {
      ...mission,
      title: 'Rodada do time',
      description: goal,
      intentContract: {
        ...mission.intentContract!,
        goal,
        acceptanceCriteria: [],
        budgets: {
          ...mission.intentContract!.budgets,
          maxWorkers: 4,
        },
      },
    };

    await act(async () => {
      root.render(
        <MissionWizardPlanReview
          mission={roundtableMission}
          squad={squad}
          roster={squad.agents}
          adapters={[adapter]}
          error={null}
          spawning={false}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onStart={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toMatch(/rodada da equipe.*somente leitura/i);
    expect(host.textContent).toMatch(/Responder em paralelo/i);
    expect(host.textContent).toMatch(/Handoffs físicos obrigatórios/i);
    expect(host.textContent).not.toMatch(
      /conduz a implementação|Revisão técnica automática ao final/i,
    );
    act(() => root.unmount());
  });

  it('keeps a promoted plan on delivery topology even when its title resembles a roundtable', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const goal =
      'Todos os panes devem responder o que fazem nesta missão';
    const promotedMission: Mission = {
      ...mission,
      description: goal,
      intentContract: {
        ...mission.intentContract!,
        goal,
        promotedPlan: {
          version: 1,
          handoffId: 'handoff-plan',
          sourceIntentVersion: 1,
          sourceSessionId: 'session-plan',
          handoffCreatedAt: 1,
          physicalReceipt: {
            receiptId: 'receipt-plan',
            toolCallId: 'tool-plan',
            source: 'http-mcp',
            authoritySha256: 'd'.repeat(64),
            issuedAt: 1,
          },
          summary: 'Plano aprovado',
          artifacts: [],
          summarySha256: 'a'.repeat(64),
          artifactsSha256: 'b'.repeat(64),
          digest: 'c'.repeat(64),
        },
      },
    };

    await act(async () => {
      root.render(
        <MissionWizardPlanReview
          mission={promotedMission}
          squad={squad}
          roster={squad.agents}
          adapters={[adapter]}
          error={null}
          spawning={false}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onStart={vi.fn()}
        />,
      );
    });

    expect(host.textContent).not.toMatch(/rodada da equipe/i);
    expect(host.textContent).toMatch(/Revisão técnica automática ao final/i);
    act(() => root.unmount());
  });
});
