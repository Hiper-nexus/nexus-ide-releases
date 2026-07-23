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
            ompProvider: 'fixture',
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
    expect(host.textContent).toMatch(/Custo estimado do roster/i);
    expect(host.textContent).toContain('$1 entrada / $8 saída por 1M tokens');
    expect(host.textContent).toMatch(/Review P0–P3 automático ao final/i);
    expect(host.textContent).toContain('Ainda não garantido');

    act(() => root.unmount());
  });
});
