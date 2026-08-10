/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Squad } from '../../../shared/orch-types';
import { useEphemeralDraftStore } from '../../state/ephemeral-draft-store';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';

const squadMocks = vi.hoisted(() => ({
  askConfirm: vi.fn(),
  deleteSquad: vi.fn(),
  exportSquads: vi.fn(),
  importSquads: vi.fn(),
  saveSquad: vi.fn(),
}));

vi.mock('../../state/confirm-store', () => ({
  askConfirm: squadMocks.askConfirm,
}));

vi.mock('./OrchestratorDefaults', () => ({
  OrchestratorDefaults: () => <div />,
}));

vi.mock('./MissionDriverSettings', () => ({
  MissionDriverSettings: () => <div />,
}));

import { SettingsWorkspace } from './SettingsWorkspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const roots = new Set<Root>();

function squad(id: string, name: string, builtin = false): Squad {
  return {
    id,
    name,
    createdAt: '1',
    builtin,
    orchestratorInstructions: 'Coordene a entrega com revisão.',
    agents: [
      {
        id: `${id}-coordinator`,
        agentName: 'Coordenador',
        category: 'orchestrator',
        cli: 'codex',
        model: 'gpt-5.6-sol',
        allowedSkills: [],
        allowedTools: null,
      },
    ],
  };
}

function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(node));
  return host;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function accessibleName(button: HTMLButtonElement): string {
  return `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`.trim();
}

function buttonByName(
  root: ParentNode,
  name: RegExp,
): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      name.test(accessibleName(button)),
    ) ?? null
  );
}

function requiredButton(root: ParentNode, name: RegExp): HTMLButtonElement {
  const button = buttonByName(root, name);
  expect(button, `Expected button matching ${String(name)}`).not.toBeNull();
  return button!;
}

function controlByLabel<T extends HTMLInputElement | HTMLTextAreaElement>(
  root: ParentNode,
  name: RegExp,
): T {
  const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find(
    (candidate) => name.test(candidate.textContent ?? ''),
  );
  const control = label?.querySelector<T>('input, textarea');
  if (!control) throw new Error(`No form control matched ${String(name)}`);
  return control;
}

function setControlValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Native value setter unavailable');
  act(() => {
    setter.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function announcementText(root: ParentNode): string {
  return [
    ...root.querySelectorAll<HTMLElement>(
      '[role="alert"], [role="status"], [aria-live]',
    ),
  ]
    .map((node) => node.textContent ?? '')
    .join(' ');
}

function renderSquads(): HTMLDivElement {
  return mount(
    <SettingsWorkspace
      section="squads"
      onBack={vi.fn()}
      onSectionChange={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useEphemeralDraftStore.getState().clearAll();
  useOrchStore.setState({ squads: [], mcpInfo: null });
  useProductNavigationStore.setState({
    destination: { kind: 'settings', section: 'squads' },
    settingsReturnDestination: { kind: 'terminal' },
  });

  squadMocks.askConfirm.mockResolvedValue(true);
  squadMocks.saveSquad.mockImplementation(async (saved: Squad) => {
    useOrchStore.setState((state) => ({
      squads: [
        ...state.squads.filter((candidate) => candidate.id !== saved.id),
        saved,
      ],
    }));
    return { ok: true, squad: saved };
  });
  squadMocks.deleteSquad.mockImplementation(async (id: string) => {
    useOrchStore.setState((state) => ({
      squads: state.squads.filter((candidate) => candidate.id !== id),
    }));
    return { ok: true };
  });
  squadMocks.exportSquads.mockResolvedValue({
    ok: true,
    path: '/exports/nexus-squads.json',
  });
  squadMocks.importSquads.mockImplementation(async () => {
    const imported = squad('squad-imported', 'Equipe importada');
    useOrchStore.setState((state) => ({
      squads: [...state.squads, imported],
    }));
    return { ok: true, count: 1 };
  });

  const orchSettings = {
    leanCode: true,
    seniorMode: true,
    designPro: true,
    designDirection: 'auto',
    designVariance: 5,
    designMotion: 5,
    designDensity: 5,
  };
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      adapters: {
        list: vi.fn(async () => []),
        onChanged: vi.fn(() => vi.fn()),
      },
      settings: {
        orchGet: vi.fn(async () => orchSettings),
        orchSet: vi.fn(async (patch: object) => ({
          ...orchSettings,
          ...patch,
        })),
      },
      orch: {
        saveSquad: squadMocks.saveSquad,
        deleteSquad: squadMocks.deleteSquad,
        exportSquads: squadMocks.exportSquads,
        importSquads: squadMocks.importSquads,
      },
    } as unknown as Window['nexus'],
  });
});

afterEach(() => {
  for (const root of [...roots].reverse()) {
    act(() => root.unmount());
    roots.delete(root);
  }
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Settings → Squads retained management capability', () => {
  it('renders an actionable empty inventory with create/import available and export disabled', async () => {
    const host = renderSquads();
    await settle();

    expect(host.textContent).toMatch(/Nenhum squad salvo/i);
    expect(buttonByName(host, /Criar squad/i)).not.toBeNull();
    expect(buttonByName(host, /Importar/i)).not.toBeNull();
    expect(buttonByName(host, /Exportar/i)?.disabled).toBe(true);
  });

  it('creates a reusable squad through SquadEditor and keeps the result in Settings', async () => {
    const host = renderSquads();
    await settle();

    act(() => requiredButton(host, /Criar squad/i).click());
    await settle();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    if (!dialog) return;

    const name = controlByLabel<HTMLInputElement>(dialog, /^Nome/i);
    setControlValue(name, 'Equipe de confiabilidade');
    act(() => requiredButton(dialog, /^Salvar$/i).click());
    await settle();

    expect(squadMocks.saveSquad).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toMatch(/Equipe de confiabilidade/i);
    expect(announcementText(host)).toMatch(/criad|salv|atualiz/i);
  });

  it('imports inventory, exports it with a durable result path, and leaves both actions in Settings', async () => {
    const host = renderSquads();
    await settle();

    act(() => requiredButton(host, /Importar/i).click());
    await settle();
    expect(host.textContent).toMatch(/Equipe importada/i);
    expect(announcementText(host)).toMatch(/Importad.+1/i);

    const exportButton = requiredButton(host, /Exportar/i);
    expect(exportButton.disabled).toBe(false);
    act(() => exportButton.click());
    await settle();

    expect(announcementText(host)).toMatch(/\/exports\/nexus-squads\.json/i);
  });

  it('edits an existing squad in place and danger-confirms deletion before changing inventory', async () => {
    useOrchStore.setState({
      squads: [squad('squad-owned', 'Equipe original')],
    });
    const host = renderSquads();
    await settle();

    act(() => requiredButton(host, /^Editar$/i).click());
    await settle();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    if (!dialog) return;
    setControlValue(
      controlByLabel<HTMLInputElement>(dialog, /^Nome/i),
      'Equipe revisada',
    );
    act(() => requiredButton(dialog, /^Salvar$/i).click());
    await settle();

    expect(host.textContent).toMatch(/Equipe revisada/i);
    expect(host.textContent).not.toMatch(/Equipe original/i);

    const cancelled = deferred<boolean>();
    squadMocks.askConfirm.mockReturnValueOnce(cancelled.promise);
    const remove = requiredButton(host, /Apagar|Excluir|Remover/i);
    act(() => remove.click());

    expect(squadMocks.deleteSquad).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(/Equipe revisada/i);
    cancelled.resolve(false);
    await settle();
    expect(host.textContent).toMatch(/Equipe revisada/i);

    const confirmed = deferred<boolean>();
    squadMocks.askConfirm.mockReturnValueOnce(confirmed.promise);
    act(() => requiredButton(host, /Apagar|Excluir|Remover/i).click());
    expect(squadMocks.deleteSquad).not.toHaveBeenCalled();
    confirmed.resolve(true);
    await settle();

    expect(squadMocks.askConfirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ danger: true }),
    );
    expect(squadMocks.deleteSquad).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector('[aria-label="Squads salvos"]')?.textContent ?? '',
    ).not.toMatch(/Equipe revisada/i);
  });

  it('keeps SquadEditor open and announces a failed create without inventing inventory', async () => {
    squadMocks.saveSquad.mockResolvedValueOnce({
      ok: false,
      error: 'O nome do squad já existe.',
    });
    const host = renderSquads();
    await settle();

    act(() => requiredButton(host, /Criar squad/i).click());
    await settle();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    if (!dialog) return;
    setControlValue(
      controlByLabel<HTMLInputElement>(dialog, /^Nome/i),
      'Equipe duplicada',
    );
    act(() => requiredButton(dialog, /^Salvar$/i).click());
    await settle();

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(announcementText(document.body)).toMatch(/nome do squad já existe/i);
    expect(host.textContent).not.toMatch(/Equipe duplicada/i);
  });

  it('announces import, export, and delete failures while preserving the current inventory', async () => {
    useOrchStore.setState({
      squads: [squad('squad-protected', 'Equipe protegida')],
    });
    squadMocks.importSquads.mockResolvedValueOnce({
      ok: false,
      error: 'Arquivo de squads inválido.',
    });
    squadMocks.exportSquads.mockRejectedValueOnce(
      new Error('Destino de exportação indisponível.'),
    );
    squadMocks.deleteSquad.mockRejectedValueOnce(
      new Error('O squad ainda está em uso.'),
    );
    const host = renderSquads();
    await settle();

    act(() => requiredButton(host, /Importar/i).click());
    await settle();
    expect(announcementText(host)).toMatch(/Arquivo de squads inválido/i);

    act(() => requiredButton(host, /Exportar/i).click());
    await settle();
    expect(announcementText(host)).toMatch(/exportação indisponível/i);

    squadMocks.askConfirm.mockResolvedValueOnce(true);
    act(() => requiredButton(host, /Apagar|Excluir|Remover/i).click());
    await settle();
    expect(announcementText(host)).toMatch(/squad ainda está em uso/i);
    expect(host.textContent).toMatch(/Equipe protegida/i);
  });
});
