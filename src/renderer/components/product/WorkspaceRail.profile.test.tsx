/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ChosenPetPortrait', () => ({ ChosenPetPortrait: () => null }));

import { WorkspaceRail, type WorkspaceRailProps } from './WorkspaceRail';
import {
  EMPTY_GAMIFICATION_SNAPSHOT,
  useGamificationStore,
} from '../../state/gamification-store';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function renderRail(overrides: Partial<WorkspaceRailProps> = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const props: WorkspaceRailProps = {
    activeWorkspaces: [],
    recentWorkspaces: [],
    selection: null,
    onCreateNew: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onSelectMission: vi.fn(),
    onOpenTaskBoard: vi.fn(),
    onOpenMemory: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenTerminals: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<WorkspaceRail {...props} />));
  return host;
}

function profileEntry(host: HTMLElement): HTMLButtonElement {
  const entry = host.querySelector<HTMLButtonElement>(
    '.workspace-rail__footer > button.operator-hud--rail',
  );
  if (!entry) throw new Error('a entrada do perfil não está no rodapé da rail');
  return entry;
}

beforeEach(() => {
  useGamificationStore.setState({
    snapshot: {
      ...EMPTY_GAMIFICATION_SNAPSHOT,
      projectId: 'proj-1',
      powerLevel: 17_400,
    },
    sober: false,
    profileOpen: false,
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('WorkspaceRail: entrada visível do Perfil de Operador', () => {
  it('fica no rodapé, entre as utilidades e Configurações, fora do que o modo foco esconde', () => {
    const host = renderRail({ selection: { kind: 'settings' } });
    const entry = profileEntry(host);
    const utilities = host.querySelector('.workspace-rail__utilities');
    const cockpit = host.querySelector('.workspace-rail__cockpit-status');

    expect(entry.getAttribute('aria-label')).toMatch(/^Perfil de Operador/);
    // O CSS do modo foco esconde `.workspace-rail__utilities`: a entrada não pode morar lá.
    expect(utilities?.contains(entry)).toBe(false);
    expect(
      utilities!.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      entry.compareDocumentPosition(cockpit!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('mostra o poder do operador e abre o perfil ao clicar', () => {
    const openProfile = vi
      .spyOn(useGamificationStore.getState(), 'openProfile')
      .mockImplementation(() => {});
    const entry = profileEntry(renderRail());

    expect(entry.textContent).toContain('17.4K');
    act(() => entry.click());

    expect(openProfile).toHaveBeenCalledOnce();
  });

  it('modo sóbrio tira o HUD da rail (o perfil segue por Configurações e pelo atalho)', () => {
    useGamificationStore.setState({ sober: true });
    const host = renderRail();

    expect(
      host.querySelector('.workspace-rail__footer > button.operator-hud--rail'),
    ).toBeNull();
  });
});
