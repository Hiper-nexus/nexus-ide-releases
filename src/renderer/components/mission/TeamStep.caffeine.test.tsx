/** @vitest-environment jsdom */
/**
 * Garante que a etapa de Equipe exibe presença cafeinada à primeira vista:
 * lata SVG 64px com aria-hidden no header, sem precisar abrir terminal.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionRuntimeReadiness } from '../../orch/mission-runtime-readiness';
import { DEFAULT_ORCH_SETTINGS } from '../../../shared/settings-types';
import { TeamStep, type MissionTeamInventory } from './TeamStep';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const emptyReadiness: MissionRuntimeReadiness = {
  detectedAdapters: [],
  authenticatedAdapters: [],
  readyProviders: [],
  verifiedMaestros: [],
  qualifiedWorkers: [],
  hasOperationalRoute: false,
  multiProviderReady: false,
};

const loadingInventory: MissionTeamInventory = {
  status: 'loading',
  adapters: [],
  providers: [],
  accounts: [],
  settings: DEFAULT_ORCH_SETTINGS,
  readiness: emptyReadiness,
  error: null,
};

const mountedRoots = new Set<Root>();

function renderTeamStep(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => {
    root.render(
      <TeamStep
        roster={[]}
        lane="standard"
        recommendationStale={false}
        revision={1}
        inventory={loadingInventory}
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

afterEach(() => {
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots.clear();
  document.body.replaceChildren();
});

describe('TeamStep — cafeína visível na etapa Equipe', () => {
  it('renderiza lata aria-hidden no header da etapa', () => {
    const host = renderTeamStep();
    const cup = host.querySelector<SVGElement>('svg.pet-coffee');
    expect(cup, 'lata SVG ausente no TeamStep').not.toBeNull();
    expect(cup?.getAttribute('aria-hidden')).toBe('true');
    expect(cup?.querySelector('.pet-coffee__body'), 'corpo da lata ausente').not.toBeNull();
    expect(cup?.querySelector('.pet-coffee__band'), 'faixa da lata ausente').not.toBeNull();
    expect(cup?.querySelector('.pet-coffee__fizz'), 'fizz da tampa ausente').not.toBeNull();
    expect(cup?.querySelector('.pet-coffee__tab'), 'lacre da lata ausente').not.toBeNull();
  });

  it('lata tem tamanho de leitura (64px)', () => {
    const host = renderTeamStep();
    const cup = host.querySelector<SVGElement>('svg.pet-coffee');
    const h = Number(cup?.getAttribute('height') ?? 0);
    expect(h, 'lata do header não é 64px').toBe(64);
  });

  it('lata está dentro do header .mission-setup__step-header', () => {
    const host = renderTeamStep();
    const header = host.querySelector('.mission-setup__step-header');
    expect(header, 'header da etapa ausente').not.toBeNull();
    const cup = header?.querySelector('svg.pet-coffee');
    expect(cup, 'lata fora do header da etapa').not.toBeNull();
  });

  it('kicker pill "Etapa 2 · Equipe" continua visível junto com a lata', () => {
    const host = renderTeamStep();
    const kicker = host.querySelector('.mission-setup__step-kicker');
    expect(kicker?.textContent).toContain('Equipe');
    const cup = host.querySelector('svg.pet-coffee');
    expect(cup).not.toBeNull();
  });
});
