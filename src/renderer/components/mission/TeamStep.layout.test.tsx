/** @vitest-environment jsdom */
/**
 * Estrutura da etapa Equipe: a barra "Voltar / Continuar" nunca divide a área
 * rolável com os cartões. Antes ela era `position: sticky` dentro do próprio
 * scroller do passo e boiava POR CIMA da lista (corte no meio do cartão e o
 * próximo cartão aparecendo por baixo). Layout real é conferido no navegador;
 * aqui fica o contrato de estrutura, que é o que impede a regressão.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SquadAgent } from '../../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { DEFAULT_ORCH_SETTINGS } from '../../../shared/settings-types';
import type { AdapterInfo } from '../../../shared/types';
import { missionRuntimeReadiness } from '../../orch/mission-runtime-readiness';
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

const COORDINATOR = agent('coord', 'Coordenar e revisar', 'orchestrator', 'claude', 'claude-opus-5-5');
const INTERFACE = agent('ui', 'Implementar interface', 'executor', 'codex', 'gpt-6.1-sol');
const ENGINE = agent('engine', 'Implementar motor', 'executor', 'codex', 'gpt-6.1-sol');
const REVIEWER = agent('qa', 'Verificar o resultado', 'reviewer', 'claude', 'claude-opus-5-5');

const mountedRoots = new Set<Root>();

function renderTeam(roster: readonly SquadAgent[]): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => {
    root.render(
      <TeamStep
        roster={roster}
        lane="standard"
        recommendationStale={false}
        revision={1}
        inventory={INVENTORY}
        entryContext={null}
        onRosterChange={vi.fn()}
        onBack={vi.fn()}
        onContinue={vi.fn()}
        onRetryInventory={vi.fn()}
        onRefreshRecommendation={vi.fn()}
      />,
    );
  });
  return host;
}

/** Mesmo TeamStep, mas com o roster vivo: remover de verdade re-renderiza o passo. */
function renderStatefulTeam(initial: readonly SquadAgent[]): HTMLElement {
  function Stateful() {
    const [roster, setRoster] = useState(initial);
    return (
      <TeamStep
        roster={roster}
        lane="standard"
        recommendationStale={false}
        revision={1}
        inventory={INVENTORY}
        entryContext={null}
        onRosterChange={setRoster}
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
  act(() => root.render(<Stateful />));
  return host;
}

function buttonNamed(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.includes(name),
  );
  if (!found) throw new Error(`Botão não encontrado: ${name}`);
  return found;
}

afterEach(() => {
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('TeamStep: barra de ações fora da área rolável', () => {
  it('o passo é docked: área rolável e dock são irmãos, nunca um dentro do outro', () => {
    const host = renderTeam([COORDINATOR, INTERFACE, ENGINE, REVIEWER]);
    const step = host.querySelector('section.mission-setup__step');
    const scroll = host.querySelector('.mission-setup__step-scroll');
    const dock = host.querySelector('.mission-setup__step-dock');

    expect(step?.classList.contains('mission-setup__step--docked')).toBe(true);
    expect(scroll?.parentElement).toBe(step);
    expect(dock?.parentElement).toBe(step);
    expect(scroll?.contains(dock ?? null)).toBe(false);
    // O dock vem depois da área rolável: é o rodapé do passo, não um item dela.
    expect(
      scroll!.compareDocumentPosition(dock!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('Voltar e Continuar moram só no dock; cabeçalho, papéis e "Adicionar papel" rolam', () => {
    const host = renderTeam([COORDINATOR, INTERFACE, ENGINE, REVIEWER]);
    const scroll = host.querySelector('.mission-setup__step-scroll')!;
    const dock = host.querySelector('.mission-setup__step-dock')!;

    for (const name of ['Voltar para missão', 'Continuar para revisão']) {
      const button = buttonNamed(host, name);
      expect(dock.contains(button), `${name} deve estar no dock`).toBe(true);
      expect(scroll.contains(button), `${name} não pode estar na área rolável`).toBe(false);
    }
    expect(scroll.contains(host.querySelector('h1'))).toBe(true);
    expect(scroll.contains(host.querySelector('ul[aria-label="Papéis da equipe"]'))).toBe(true);
    expect(scroll.contains(buttonNamed(host, 'Adicionar implementação'))).toBe(true);
    expect(dock.querySelectorAll('.mission-roster-row')).toHaveLength(0);
  });

  it('o motivo do bloqueio aparece no dock, junto do botão que ele descreve', () => {
    // Sem verificação independente a equipe não pode seguir para a revisão.
    const host = renderTeam([COORDINATOR, INTERFACE]);
    const dock = host.querySelector('.mission-setup__step-dock')!;
    const reason = host.querySelector('#mission-team-continue-reason');
    const proceed = buttonNamed(host, 'Continuar para revisão');

    expect(reason?.textContent).toContain('verificar a entrega');
    expect(dock.contains(reason)).toBe(true);
    expect(proceed.getAttribute('aria-describedby')).toBe('mission-team-continue-reason');
  });

  it('equipe pronta não deixa texto de bloqueio nem referência a ele', () => {
    const host = renderTeam([COORDINATOR, INTERFACE, ENGINE, REVIEWER]);

    expect(host.querySelector('#mission-team-continue-reason')).toBeNull();
    expect(
      buttonNamed(host, 'Continuar para revisão').hasAttribute('aria-describedby'),
    ).toBe(false);
  });
});

describe('TeamStep: remover papel', () => {
  it('cada papel removível tem um botão de ícone nomeado pelo papel; a coordenação única não tem', () => {
    const host = renderTeam([COORDINATOR, INTERFACE, ENGINE, REVIEWER]);
    const removeButtons = [
      ...host.querySelectorAll<HTMLButtonElement>('.mission-roster-row__remove'),
    ];

    expect(removeButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Remover Implementar interface',
      'Remover Implementar motor',
      'Remover Verificar o resultado',
    ]);
    for (const button of removeButtons) {
      // Ação discreta: só o ícone (aria-hidden) e dica no hover; nada de texto
      // longo disputando espaço com o estado e os controles do cartão.
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
    }
    const coordinatorRow = host.querySelector('[data-category="orchestrator"]')!;
    expect(coordinatorRow.querySelector('.mission-roster-row__remove')).toBeNull();
  });

  it('depois de remover um papel o foco vai para um controle inofensivo do vizinho, nunca para o Remover dele', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const host = renderStatefulTeam([COORDINATOR, INTERFACE, ENGINE, REVIEWER]);
    focus.mockClear();

    act(() =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Remover Implementar interface"]')!
        .click(),
    );

    // Um Enter a mais no Remover do vizinho apagaria o próximo papel sem pedido.
    const target = focus.mock.contexts.at(-1) as HTMLElement | undefined;
    expect(target?.tagName).toBe('SUMMARY');
    expect(target?.closest('.mission-roster-row')?.textContent).toContain('Implementar motor');
    expect(host.textContent).not.toContain('Implementar interface');
  });
});

describe('TeamStep: contagem de integrantes', () => {
  it('é uma região de status: adicionar, remover e presets são anunciados', () => {
    const host = renderStatefulTeam([COORDINATOR, INTERFACE, ENGINE, REVIEWER]);
    const chip = host.querySelector('.mission-setup__count-chip');

    expect(chip?.getAttribute('role')).toBe('status');
    expect(chip?.textContent).toBe('4 integrantes');

    act(() =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Remover Implementar motor"]')!
        .click(),
    );
    expect(host.querySelector('.mission-setup__count-chip')?.textContent).toBe('3 integrantes');
  });
});
