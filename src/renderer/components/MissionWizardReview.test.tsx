/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import type { AdapterInfo } from '../../shared/types';
import { MissionWizardReview } from './MissionWizardReview';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const orchestrator: SquadAgent = {
  id: 'orch',
  agentName: 'Maestro',
  category: 'orchestrator',
  cli: 'codex',
  model: 'gpt-5.4',
  effort: 'high',
  allowedTools: null,
};

const squad: Squad = {
  id: 'squad-1',
  name: 'Operação',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: '',
  agents: [orchestrator],
};

const codex: AdapterInfo = {
  id: 'codex',
  kind: 'cli-pty',
  label: 'Codex',
  icon: '◇',
  models: { list: ['gpt-5.4'], default: 'gpt-5.4' },
  installed: true,
  orchestratorCapable: true,
  installCommand: '',
  idleTimeoutMs: 800,
};

describe('MissionWizardReview orchestrator provider', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the provider selected in Settings without a Claude-only claim', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MissionWizardReview
          squad={squad}
          roster={[orchestrator]}
          adapters={[codex]}
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={vi.fn()}
        />,
      );
    });

    expect(
      host.querySelector('.wizard__mini-select--locked')?.textContent,
    ).toContain('Codex');
    expect(host.textContent).toContain(
      'O orquestrador usa o provider padrão de Configurações.',
    );
    expect(host.textContent).not.toContain('fixo em Claude');
    act(() => root.unmount());
  });
});
