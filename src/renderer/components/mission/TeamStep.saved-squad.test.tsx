/** @vitest-environment jsdom */
/**
 * F-1578: na etapa Equipe do assistente de Nova missão o operador escolhe uma
 * equipe salva como ponto de partida. A escolha passa pela MESMA conversão do
 * "Usar integrantes" de Ajustes → Equipes (`setRoster` do rascunho), e os
 * presets de tamanho continuam lá.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Squad, SquadAgent } from '../../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { DEFAULT_ORCH_SETTINGS } from '../../../shared/settings-types';
import { PET_STUDIO_SQUAD } from '../../../shared/pet-studio';
import type { AdapterInfo } from '../../../shared/types';
import { missionRuntimeReadiness } from '../../orch/mission-runtime-readiness';
import { useMissionSetupStore } from '../../state/mission-setup-store';
import { useOrchStore } from '../../state/orch-store';
import { TeamStep, type MissionTeamInventory } from './TeamStep';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function adapter(id: string, label: string, model: string): AdapterInfo {
  return {
    id,
    kind: 'cli-pty',
    label,
    icon: label.slice(0, 1),
    models: { list: [model], default: model },
    installed: true,
    installCommand: '',
    idleTimeoutMs: 1_000,
    orchestratorCapable: true,
    missionControlCapable: true,
    autonomousWorkspaceWriteCapable: true,
    orchestrationEvidence: 'unsupported',
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: true,
      governedWriter: true,
      verifiedMaestro: true,
    },
  };
}

function provider(id: string, label: string, model: string): ProviderSettingsInfo {
  return {
    adapterId: id,
    label,
    icon: label.slice(0, 1),
    kind: 'cli-pty',
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: id,
    defaultModel: model,
    models: [model],
    authReadyModels: [model],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'oauth',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: id,
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: 'high',
    efforts: ['low', 'medium', 'high'],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
  };
}

const ADAPTERS = [
  adapter('claude', 'Claude', 'claude-opus-5-5'),
  adapter('codex', 'Codex', 'gpt-6.1-sol'),
];
const PROVIDERS = [
  provider('claude', 'Claude', 'claude-opus-5-5'),
  provider('codex', 'Codex', 'gpt-6.1-sol'),
];
const INVENTORY: MissionTeamInventory = {
  status: 'ready',
  adapters: ADAPTERS,
  providers: PROVIDERS,
  accounts: [],
  settings: DEFAULT_ORCH_SETTINGS,
  readiness: missionRuntimeReadiness(ADAPTERS, PROVIDERS, []),
  error: null,
};

function agent(
  id: string,
  agentName: string,
  category: SquadAgent['category'],
  cli: string,
  model: string,
): SquadAgent {
  return { id, agentName, category, cli, model, allowedSkills: [], allowedTools: null };
}

const RECOMMENDED = [
  agent('coord', 'Coordenar e revisar', 'orchestrator', 'claude', 'claude-opus-5-5'),
  agent('ui', 'Implementar interface', 'executor', 'codex', 'gpt-6.1-sol'),
  agent('qa', 'Verificar o resultado', 'reviewer', 'claude', 'claude-opus-5-5'),
];

function squad(id: string, name: string, builtin: boolean, agents: SquadAgent[]): Squad {
  return { id, name, createdAt: '1', builtin, orchestratorInstructions: '', agents };
}

const ORIGINAL = squad('nexus-fullstack', 'Full-Stack', true, [
  agent('fs-orch', 'Maestro Full-Stack', 'orchestrator', 'claude', 'claude-opus-5-5'),
  agent('fs-dev', 'Dev Full-Stack', 'executor', 'codex', 'gpt-6.1-sol'),
  agent('fs-qa', 'QA Full-Stack', 'reviewer', 'claude', 'claude-opus-5-5'),
]);
const GBX = squad('full-stack-gbx', 'Full-Stack - GBX', false, [
  agent('gbx-orch', 'Maestro GBX', 'orchestrator', 'codex', 'gpt-6.1-sol'),
  { ...agent('gbx-api', 'API GBX', 'executor', 'codex', 'gpt-6.1-sol'), ownsPlanDocs: true },
  agent('gbx-front', 'Front GBX', 'executor', 'claude', 'claude-opus-5-5'),
  agent('gbx-qa', 'QA GBX', 'reviewer', 'claude', 'claude-opus-5-5'),
]);
const RUNTIME_COPY = squad(
  'mission-runtime-0f8fad5b-d9cb-469f-a165-70867728950e',
  'Cópia selada',
  false,
  [agent('rt-orch', 'Maestro selado', 'orchestrator', 'claude', 'claude-opus-5-5')],
);
const TOO_BIG = squad(
  'equipe-grande',
  'Equipe grande',
  false,
  Array.from({ length: 13 }, (_, index) =>
    agent(`big-${index}`, `Agente ${index}`, index === 0 ? 'orchestrator' : 'executor', 'codex', 'gpt-6.1-sol'),
  ),
);

const WORKSPACE = '/tmp/team-step-saved-squad';
const mountedRoots = new Set<Root>();

/** TeamStep ligado ao rascunho real, como na MissionSetup. */
function renderStoreBackedTeam(
  entryContext: Parameters<typeof TeamStep>[0]['entryContext'] = null,
): HTMLElement {
  function StoreBacked() {
    const roster = useMissionSetupStore((state) => state.draft.roster);
    return (
      <TeamStep
        roster={roster}
        lane="standard"
        recommendationStale={false}
        revision={1}
        inventory={INVENTORY}
        entryContext={entryContext}
        onRosterChange={(next) => useMissionSetupStore.getState().setRoster(next)}
        onBack={vi.fn()}
        onContinue={vi.fn()}
        onRetryInventory={vi.fn()}
        onRefreshRecommendation={vi.fn()}
      />
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => root.render(<StoreBacked />));
  return host;
}

function savedSquadSelect(host: HTMLElement): HTMLSelectElement {
  const select = host.querySelector<HTMLSelectElement>('#mission-saved-squad');
  if (!select) throw new Error('seletor de equipe salva ausente');
  return select;
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  useMissionSetupStore.getState().setWorkspace(WORKSPACE);
  useMissionSetupStore.getState().resetWorkspace(WORKSPACE);
  useMissionSetupStore.getState().setRoster(RECOMMENDED);
  useOrchStore.setState({ squads: [ORIGINAL, RUNTIME_COPY, PET_STUDIO_SQUAD, GBX, TOO_BIG] });
});

afterEach(() => {
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots.clear();
  document.body.replaceChildren();
  useOrchStore.setState({ squads: [] });
  vi.restoreAllMocks();
});

describe('TeamStep: começar de uma equipe salva (F-1578)', () => {
  it('lista as equipes do usuário antes das originais, sem cópias de missão nem o Pet Studio', () => {
    const host = renderStoreBackedTeam();
    const select = savedSquadSelect(host);
    const label = host.querySelector('label[for="mission-saved-squad"]');

    expect(label?.textContent).toBe('Começar de uma equipe salva');
    const groups = [...select.querySelectorAll('optgroup')].map((group) => ({
      label: group.label,
      options: [...group.querySelectorAll('option')].map((option) => option.textContent),
    }));
    expect(groups).toEqual([
      { label: 'Suas equipes', options: ['Full-Stack - GBX', 'Equipe grande'] },
      { label: 'Originais', options: ['Full-Stack'] },
    ]);
    expect(select.value).toBe('');
    expect(select.textContent).not.toContain('Cópia selada');
    expect(select.textContent).not.toContain(PET_STUDIO_SQUAD.name);
  });

  it('aplica os integrantes da equipe escolhida pela mesma conversão do "Usar integrantes"', () => {
    const host = renderStoreBackedTeam();

    choose(savedSquadSelect(host), GBX.id);

    const roster = useMissionSetupStore.getState().draft.roster;
    expect(roster.map((member) => member.id)).toEqual(GBX.agents.map((member) => member.id));
    // A autoridade de plano nunca entra no rascunho (fronteira do setRoster).
    expect(roster.every((member) => member.ownsPlanDocs === undefined)).toBe(true);
    expect(host.querySelector('.mission-setup__count-chip')?.textContent).toBe('4 integrantes');
    expect(host.textContent).toContain('Maestro GBX');
    expect(host.textContent).toContain('Integrantes de “Full-Stack - GBX” aplicados.');
    expect(savedSquadSelect(host).value).toBe('');

    // Trocar de novo é possível: a equipe original substitui a anterior.
    choose(savedSquadSelect(host), ORIGINAL.id);
    expect(useMissionSetupStore.getState().draft.roster.map((member) => member.id)).toEqual(
      ORIGINAL.agents.map((member) => member.id),
    );
  });

  it('avisa e mantém a equipe atual quando a escolhida não cabe na missão', () => {
    const host = renderStoreBackedTeam();

    choose(savedSquadSelect(host), TOO_BIG.id);

    expect(useMissionSetupStore.getState().draft.roster.map((member) => member.id)).toEqual(
      RECOMMENDED.map((member) => member.id),
    );
    const alert = [...host.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(' ');
    expect(alert).toMatch(/tem 13 pessoas e a missão aceita até 12/);
    expect(host.textContent).not.toContain('aplicados.');
  });

  it('mantém os presets de tamanho da equipe', () => {
    const host = renderStoreBackedTeam();

    expect(host.querySelector('[role="group"][aria-label="Tamanho da equipe"]')).not.toBeNull();
  });

  it('não aparece no fluxo do Pet Studio, que tem equipe própria', () => {
    const host = renderStoreBackedTeam({
      kind: 'pet-studio',
      origin: 'settings-appearance',
      objective: 'Criar pet',
      title: 'Pet',
      roster: PET_STUDIO_SQUAD.agents,
      profile: { kind: 'pet-studio', referenceImagePath: 'pet.png' },
      step: 'review',
      revision: 1,
    });

    expect(host.querySelector('#mission-saved-squad')).toBeNull();
  });

  it('não aparece sem equipes salvas', () => {
    useOrchStore.setState({ squads: [RUNTIME_COPY, PET_STUDIO_SQUAD] });
    const host = renderStoreBackedTeam();

    expect(host.querySelector('#mission-saved-squad')).toBeNull();
  });
});
