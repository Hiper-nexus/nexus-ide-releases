import { useEffect } from 'react';
import { ActivationChecklist } from './ActivationChecklist';
import { HowToUseGuide } from './HowToUseGuide';
import { useOnboardingStore } from '../../state/onboarding-store';
import { useProviderStore } from '../../state/provider-store';
import { useAccountStore } from '../../state/account-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { usePanePickerStore } from '../../state/pane-picker-store';
import { openExpressBareShell } from '../mission/ExpressTerminalOptions';

/**
 * Residual first-steps block on the creation home. Handlers call the real
 * stores (same pattern as ExpressTerminalOptions) so MissionSetup props stay
 * untouched.
 *
 * Auto-marking is deliberate and narrow:
 * - connectedAccount / openedProject / createdMission come only from live
 *   facts (`syncDerivedFlags`) — opening a dialog is not activation.
 * - dictatedWithSpace / openedPlusPane are marked at the real product hooks
 *   (voice PTT start, pane-picker `requestOpen`), not on navigation clicks.
 */
export function FirstStepsGuide(): React.JSX.Element {
  const syncDerivedFlags = useOnboardingStore((s) => s.syncDerivedFlags);
  const markChecklist = useOnboardingStore((s) => s.markChecklist);

  const providers = useProviderStore((s) => s.providers);
  const accounts = useAccountStore((s) => s.accounts);
  const workspace = useWorkspaceStore((s) => s.current);
  const missions = useOrchStore((s) => s.missions);

  useEffect(() => {
    const usableProviders = providers.filter((p) =>
      p.credentialReadiness !== 'invalid-credential' &&
      p.credentialReadiness !== 'no-credential',
    );
    const hasKey = usableProviders.some((p) => p.hasKey);
    // Sessão de CLI/subscription prova conta mesmo sem chave (Codex/Claude OAuth).
    const hasSession = usableProviders.some((p) => p.authState === 'ok');
    const hasAccount = accounts.some((account) =>
      account.hasCredential && !account.needsRelogin,
    );
    syncDerivedFlags({
      hasLiveAccountOrKey: hasKey || hasSession || hasAccount,
      hasWorkspace: Boolean(workspace?.path),
      hasMission: missions.length > 0,
    });
  }, [providers, accounts, workspace, missions, syncDerivedFlags]);

  const openApiKeys = () =>
    useProductNavigationStore.getState().openSettings('api-keys');
  const openProviders = () =>
    useProductNavigationStore.getState().openSettings('providers');
  const openWorkspace = () => {
    void useWorkspaceStore.getState().pick();
  };
  const startMission = () => {
    useProductNavigationStore.getState().openMissionSetup();
  };
  const openPlusPane = () => {
    usePanePickerStore.getState().requestOpen();
    // requestOpen already marks openedPlusPane; keep a belt for this CTA.
    markChecklist('openedPlusPane');
  };
  const explainDictation = () => {
    document
      .getElementById('howto-guide-title')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  return (
    <>
      <ActivationChecklist
        onOpenProviders={openProviders}
        onOpenWorkspace={openWorkspace}
        onExplainDictation={explainDictation}
        onOpenPane={openPlusPane}
        onStartMission={startMission}
      />
      <HowToUseGuide
        onOpenApiKeys={openApiKeys}
        onOpenProviders={openProviders}
        onOpenPane={openPlusPane}
        onStartMission={startMission}
        onOpenWorkspace={openWorkspace}
        onOpenShellTerminal={openExpressBareShell}
      />
    </>
  );
}
