/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  activationChecklistRemaining,
  shouldShowFirstRunWizard,
  stepIdForIndex,
  useOnboardingStore,
} from './onboarding-store';
import {
  getDefaultOnboardingState,
  ONBOARDING_FLOW_VERSION,
} from '../../shared/constants';

describe('onboarding-store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOnboardingStore.getState().reset();
    useOnboardingStore.setState({ hydrated: false, wizardOpen: false, stepIndex: 0 });
  });

  it('opens the wizard only for a fresh current-flow state', () => {
    expect(
      shouldShowFirstRunWizard({
        ...getDefaultOnboardingState(),
        flowVersion: ONBOARDING_FLOW_VERSION,
      }),
    ).toBe(true);
    expect(
      shouldShowFirstRunWizard({
        ...getDefaultOnboardingState(),
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: 1,
      }),
    ).toBe(false);
    expect(
      shouldShowFirstRunWizard({
        ...getDefaultOnboardingState(),
        flowVersion: 4,
      }),
    ).toBe(false);
  });

  it('maps step indexes to keys → agents → project → use', () => {
    expect(stepIdForIndex(0)).toBe('keys');
    expect(stepIdForIndex(3)).toBe('use');
    expect(stepIdForIndex(9)).toBe('use');
    expect(stepIdForIndex(-1)).toBe('keys');
  });

  it('persists checklist marks and derives remaining work', () => {
    const store = useOnboardingStore.getState();
    store.markChecklist('dictatedWithSpace');
    expect(useOnboardingStore.getState().state.checklist.dictatedWithSpace).toBe(
      true,
    );
    const remaining = activationChecklistRemaining(
      useOnboardingStore.getState().state.checklist,
    );
    expect(remaining).not.toContain('dictatedWithSpace');
    expect(remaining).toContain('connectedAccount');
  });

  it('closes the wizard as completed and marks last step', () => {
    const store = useOnboardingStore.getState();
    store.openWizard();
    store.completeStep(1);
    store.closeWizard('completed');
    const state = useOnboardingStore.getState().state;
    expect(state.outcome).toBe('completed');
    expect(state.closedAt).toBeGreaterThan(0);
    expect(state.lastCompletedStep).toBe(4);
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    expect(shouldShowFirstRunWizard(state)).toBe(false);
  });

  it('syncs derived activation flags from product facts', () => {
    useOnboardingStore.getState().syncDerivedFlags({
      hasLiveAccountOrKey: true,
      hasWorkspace: true,
      hasMission: false,
    });
    const checklist = useOnboardingStore.getState().state.checklist;
    expect(checklist.connectedAccount).toBe(true);
    expect(checklist.openedProject).toBe(true);
    expect(checklist.createdMission).toBe(false);
  });
});

describe('hydrate: wizard só em instalação nova (update não tem a chave v5)', () => {
  const flushProbe = () => new Promise((r) => setTimeout(r, 0));

  function mockNexus(signals: {
    workspace?: unknown;
    accounts?: unknown[];
    providers?: unknown[];
    missions?: unknown[];
  }): void {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      writable: true,
      value: {
        workspace: {
          get: vi.fn(async () => signals.workspace ?? { current: null, recents: [] }),
        },
        accounts: { list: vi.fn(async () => signals.accounts ?? []) },
        providers: { list: vi.fn(async () => signals.providers ?? []) },
        orch: { listMissions: vi.fn(async () => signals.missions ?? []) },
      },
    });
  }

  beforeEach(() => {
    useOnboardingStore.getState().reset();
    useOnboardingStore.setState({ hydrated: false, wizardOpen: false, stepIndex: 0 });
    // reset() persiste o default; a chave precisa SUMIR para simular update.
    window.localStorage.clear();
  });

  afterEach(() => {
    // @ts-expect-error remove o bridge mockado
    delete window.nexus;
  });

  it('RED/GREEN: usuário existente sem a chave v5 mas com workspace → wizard fechado e migração silenciosa', async () => {
    mockNexus({
      workspace: { current: { path: '/proj' }, recents: [] },
      providers: [{ hasKey: true }],
    });
    useOnboardingStore.getState().hydrate();
    // Nunca abre no sync — a decisão espera a sonda de uso anterior.
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    await flushProbe();
    const after = useOnboardingStore.getState();
    expect(after.wizardOpen).toBe(false);
    expect(after.state.closedAt).not.toBeNull();
    expect(after.state.outcome).toBe('completed');
    expect(after.state.checklist.dismissed).toBe(true);
    // Migração gravada: o próximo boot nem sonda.
    expect(window.localStorage.getItem('nexus.onboarding.v5')).toContain(
      '"outcome":"completed"',
    );
  });

  it('RED/GREEN: sinal por conta ou missão também fecha o wizard', async () => {
    mockNexus({ accounts: [{ id: 'acct-1' }] });
    useOnboardingStore.getState().hydrate();
    await flushProbe();
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);

    window.localStorage.clear();
    useOnboardingStore.getState().reset();
    useOnboardingStore.setState({ hydrated: false, wizardOpen: false });
    // reset() persiste o default — limpar de novo para simular update.
    window.localStorage.clear();
    mockNexus({ missions: [{ id: 'm-1' }] });
    useOnboardingStore.getState().hydrate();
    await flushProbe();
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
  });

  it('RED/GREEN: instalação nova (sem chave v5 e sem nenhum sinal) → wizard abre', async () => {
    mockNexus({});
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    await flushProbe();
    expect(useOnboardingStore.getState().wizardOpen).toBe(true);
    // Nada migrado: o estado segue fresco para o fluxo real.
    expect(useOnboardingStore.getState().state.closedAt).toBeNull();
  });

  it('estado v5 já gravado decide na hora, sem sonda', async () => {
    mockNexus({ accounts: [{ id: 'acct-1' }] });
    window.localStorage.setItem(
      'nexus.onboarding.v5',
      JSON.stringify({
        ...getDefaultOnboardingState(),
        flowVersion: ONBOARDING_FLOW_VERSION,
      }),
    );
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().wizardOpen).toBe(true);
    await flushProbe();
    // Com a chave presente, os sinais de uso não são consultados.
    expect(
      (window.nexus as unknown as { accounts: { list: unknown } }).accounts.list,
    ).not.toHaveBeenCalled();
  });
});
