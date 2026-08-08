import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  missionPrepareRequestSchema,
  type MissionPrepareRequest,
  type MissionReview,
} from '../../../shared/mission-engine-contract';
import {
  clampMissionLaneTools,
  type MissionLane,
} from '../../../shared/mission-intent';
import type { SquadAgent } from '../../../shared/orch-types';
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from '../../../shared/settings-types';
import { missionRuntimeReadiness } from '../../orch/mission-runtime-readiness';
import {
  type MissionSetupDraft,
  type MissionSetupPersistenceState,
  type MissionSetupStep,
  useMissionSetupStore,
} from '../../state/mission-setup-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { MissionStep } from './MissionStep';
import {
  ReviewStep,
  type MissionPrepareStatus,
  type MissionStartStatus,
} from './ReviewStep';
import {
  buildRecommendedMissionRoster,
  TeamStep,
  type MissionTeamInventory,
} from './TeamStep';

const STEP_LABELS: ReadonlyArray<{
  step: MissionSetupStep;
  label: string;
}> = [
  { step: 'mission', label: 'Missão' },
  { step: 'team', label: 'Equipe' },
  { step: 'review', label: 'Revisar' },
];

interface ReviewEnvelope {
  authorityKey: string;
  review: MissionReview;
}

type InventorySettingsResult =
  | { ok: true; settings: OrchSettings }
  | { ok: false };

function missionSetupPersistenceMessage(
  persistence: MissionSetupPersistenceState,
): string | null {
  if (persistence.status !== 'error') return null;

  switch (persistence.reason) {
    case 'quota-exceeded':
      return 'O armazenamento local está cheio. O rascunho atual continua somente na memória.';
    case 'corrupt-payload':
      return 'O rascunho salvo está corrompido e não foi carregado. O rascunho atual está somente na memória.';
    case 'unsupported-version':
      return 'O rascunho salvo foi criado por outra versão e não foi carregado. O rascunho atual está somente na memória.';
    case 'invalid-payload':
      return 'O rascunho salvo não é válido e não foi carregado. O rascunho atual está somente na memória.';
    case 'read-failed':
      return 'Não foi possível ler o rascunho salvo. O rascunho atual continua somente na memória.';
    case 'write-failed':
      return 'Não foi possível salvar este rascunho. Ele continua somente na memória.';
    case 'storage-unavailable':
      return persistence.operation === 'read'
        ? 'Não foi possível acessar o armazenamento para ler este projeto. O rascunho atual está somente na memória.'
        : 'Não foi possível acessar o armazenamento para salvar este rascunho. Ele continua somente na memória.';
  }
}

export function missionPrepareRequestFromDraft(
  draft: MissionSetupDraft,
): MissionPrepareRequest {
  const title = draft.title.trim();
  return {
    objective: draft.objective.trim(),
    ...(title ? { title } : {}),
    contextPaths: [...draft.contextPaths],
    roster: draft.roster.map((agent) => ({
      ...agent,
      ...(agent.allowedSkills === undefined
        ? {}
        : {
            allowedSkills:
              agent.allowedSkills === null ? null : [...agent.allowedSkills],
          }),
      allowedTools: clampMissionLaneTools(
        draft.advanced.lane,
        agent.category,
        agent.allowedTools,
      ),
    })),
    advanced: { lane: draft.advanced.lane },
  };
}

function emptyInventory(): MissionTeamInventory {
  return {
    status: 'loading',
    adapters: [],
    providers: [],
    accounts: [],
    settings: DEFAULT_ORCH_SETTINGS,
    readiness: missionRuntimeReadiness(
      [],
      [],
      [],
      DEFAULT_ORCH_SETTINGS.squadCliPolicy,
    ),
    error: null,
  };
}

function missionRosterFingerprint(roster: readonly SquadAgent[]): string {
  return JSON.stringify(roster) ?? '[]';
}

export function MissionSetup() {
  const workspace = useWorkspaceStore((state) => state.current);
  const pickWorkspace = useWorkspaceStore((state) => state.pick);
  const workspacePath = useMissionSetupStore((state) => state.workspacePath);
  const draft = useMissionSetupStore((state) => state.draft);
  const persistence = useMissionSetupStore((state) => state.persistence);
  const setWorkspace = useMissionSetupStore((state) => state.setWorkspace);
  const setObjective = useMissionSetupStore((state) => state.setObjective);
  const setTitle = useMissionSetupStore((state) => state.setTitle);
  const setContextPaths = useMissionSetupStore(
    (state) => state.setContextPaths,
  );
  const setRoster = useMissionSetupStore((state) => state.setRoster);
  const setAdvancedLane = useMissionSetupStore(
    (state) => state.setAdvancedLane,
  );
  const setStep = useMissionSetupStore((state) => state.setStep);
  const retryPersistence = useMissionSetupStore(
    (state) => state.retryPersistence,
  );
  const resetWorkspace = useMissionSetupStore(
    (state) => state.resetWorkspace,
  );

  const [inventoryAttempt, setInventoryAttempt] = useState(0);
  const [inventory, setInventory] = useState<MissionTeamInventory>(
    emptyInventory,
  );
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState<
    string | null
  >(null);
  const [reviewEnvelope, setReviewEnvelope] = useState<ReviewEnvelope | null>(
    null,
  );
  const [prepareStatus, setPrepareStatus] =
    useState<MissionPrepareStatus>('idle');
  const [startStatus, setStartStatus] =
    useState<MissionStartStatus>('idle');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [recommendationStale, setRecommendationStale] = useState(false);

  const pickingWorkspaceRef = useRef(false);
  const authorityGenerationRef = useRef(0);
  const startGenerationRef = useRef(0);
  const pendingPrepareKeyRef = useRef<string | null>(null);
  const pendingStartKeyRef = useRef<string | null>(null);
  const enteredReviewKeyRef = useRef<string | null>(null);
  const lastAuthorityKeyRef = useRef<string | null | undefined>(undefined);
  const automaticRosterFingerprintRef = useRef<string | null>(null);
  const recommendationWorkspaceRef = useRef<
    string | null | undefined
  >(undefined);
  const persistedDraftReadAlertRef = useRef<HTMLDivElement>(null);

  const canonicalWorkspacePath = workspace?.path ?? null;
  const authorityKey = workspacePath
    ? `${workspacePath}\u0000${draft.revision}`
    : null;
  const visibleReview =
    reviewEnvelope && reviewEnvelope.authorityKey === authorityKey
      ? reviewEnvelope.review
      : null;
  const hasUnreadDraft =
    persistence.status === 'error' && persistence.operation === 'read';

  useLayoutEffect(() => {
    setWorkspace(canonicalWorkspacePath);
  }, [canonicalWorkspacePath, setWorkspace]);

  useLayoutEffect(() => {
    if (hasUnreadDraft) persistedDraftReadAlertRef.current?.focus();
  }, [hasUnreadDraft]);

  useEffect(() => {
    if (recommendationWorkspaceRef.current === workspacePath) return;
    recommendationWorkspaceRef.current = workspacePath;
    automaticRosterFingerprintRef.current = null;
    setRecommendationStale(false);
  }, [workspacePath]);

  useEffect(() => {
    let cancelled = false;
    setInventory(emptyInventory());
    void Promise.all([
      window.nexus.adapters.list(),
      window.nexus.providers.list(),
      window.nexus.accounts.list(),
      window.nexus.settings.orchGet().then(
        (settings): InventorySettingsResult => ({ ok: true, settings }),
        (): InventorySettingsResult => ({ ok: false }),
      ),
    ])
      .then(([adapters, providers, accounts, settingsResult]) => {
        if (cancelled) return;
        const settings = settingsResult.ok
          ? settingsResult.settings
          : DEFAULT_ORCH_SETTINGS;
        const readiness = missionRuntimeReadiness(
          adapters,
          providers,
          accounts,
          settings.squadCliPolicy,
        );
        if (!settingsResult.ok) {
          setInventory({
            status: 'error',
            adapters,
            providers,
            accounts,
            settings,
            readiness,
            error:
              'Não foi possível carregar a política da equipe. A lista está em modo reduzido; tente novamente antes de aceitar uma recomendação.',
          });
          return;
        }
        setInventory({
          status: 'ready',
          adapters,
          providers,
          accounts,
          settings,
          readiness,
          error: null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setInventory({
          ...emptyInventory(),
          status: 'error',
          error:
            'Não foi possível carregar as ferramentas disponíveis. Tente novamente.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [inventoryAttempt]);

  useEffect(() => {
    if (
      !workspacePath ||
      hasUnreadDraft ||
      inventory.status !== 'ready' ||
      !draft.objective.trim()
    ) {
      return;
    }
    const currentFingerprint = missionRosterFingerprint(draft.roster);
    const isAutomatic =
      automaticRosterFingerprintRef.current !== null &&
      automaticRosterFingerprintRef.current === currentFingerprint;
    if (draft.roster.length > 0 && !isAutomatic) return;

    const recommended = buildRecommendedMissionRoster({
      readiness: inventory.readiness,
      providers: inventory.providers,
      accounts: inventory.accounts,
      settings: inventory.settings,
      objective: draft.objective,
      lane: draft.advanced.lane,
    });
    if (!recommended) return;
    const recommendedFingerprint = missionRosterFingerprint(recommended);
    automaticRosterFingerprintRef.current = recommendedFingerprint;
    setRecommendationStale(false);
    if (recommendedFingerprint !== currentFingerprint) {
      setRoster(recommended);
    }
  }, [
    draft.advanced.lane,
    draft.objective,
    draft.roster,
    hasUnreadDraft,
    inventory,
    setRoster,
    workspacePath,
  ]);

  useEffect(() => {
    if (lastAuthorityKeyRef.current === undefined) {
      lastAuthorityKeyRef.current = authorityKey;
      return;
    }
    if (lastAuthorityKeyRef.current === authorityKey) return;

    lastAuthorityKeyRef.current = authorityKey;
    authorityGenerationRef.current += 1;
    startGenerationRef.current += 1;
    pendingPrepareKeyRef.current = null;
    pendingStartKeyRef.current = null;
    enteredReviewKeyRef.current =
      draft.step === 'review' ? authorityKey : null;
    setReviewEnvelope(null);
    setPrepareStatus('idle');
    setStartStatus('idle');
    setReviewError(null);
    if (draft.step === 'review') setStep('team');
  }, [authorityKey, draft.step, setStep]);

  const inventoryReadyForReview =
    inventory.status === 'ready' &&
    inventory.readiness.hasOperationalRoute;

  const runPrepare = async (capturedAuthorityKey: string): Promise<void> => {
    if (pendingPrepareKeyRef.current === capturedAuthorityKey) return;
    const setupState = useMissionSetupStore.getState();
    const currentWorkspacePath =
      useWorkspaceStore.getState().current?.path ?? null;
    const currentKey = setupState.workspacePath
      ? `${setupState.workspacePath}\u0000${setupState.draft.revision}`
      : null;
    if (
      currentKey !== capturedAuthorityKey ||
      currentWorkspacePath !== setupState.workspacePath
    ) {
      return;
    }

    const requestResult = missionPrepareRequestSchema.safeParse(
      missionPrepareRequestFromDraft(setupState.draft),
    );
    if (!requestResult.success) {
      setReviewEnvelope(null);
      setPrepareStatus('error');
      setReviewError(
        'Revise o objetivo, os arquivos e a equipe antes de tentar novamente.',
      );
      return;
    }

    const generation = ++authorityGenerationRef.current;
    pendingPrepareKeyRef.current = capturedAuthorityKey;
    setReviewEnvelope(null);
    setPrepareStatus('loading');
    setStartStatus('idle');
    setReviewError(null);

    try {
      const review = await window.nexus.mission.prepare(requestResult.data);
      const latestSetup = useMissionSetupStore.getState();
      const latestWorkspace = useWorkspaceStore.getState().current?.path ?? null;
      const latestKey = latestSetup.workspacePath
        ? `${latestSetup.workspacePath}\u0000${latestSetup.draft.revision}`
        : null;
      if (
        generation !== authorityGenerationRef.current ||
        latestKey !== capturedAuthorityKey ||
        latestWorkspace !== latestSetup.workspacePath
      ) {
        return;
      }
      setReviewEnvelope({ authorityKey: capturedAuthorityKey, review });
      setPrepareStatus('ready');
    } catch {
      if (generation !== authorityGenerationRef.current) return;
      setReviewEnvelope(null);
      setPrepareStatus('error');
      setReviewError(
        'Não foi possível preparar a revisão. O rascunho foi preservado; tente novamente.',
      );
    } finally {
      if (
        generation === authorityGenerationRef.current &&
        pendingPrepareKeyRef.current === capturedAuthorityKey
      ) {
        pendingPrepareKeyRef.current = null;
      }
    }
  };

  useEffect(() => {
    if (draft.step !== 'review' || !authorityKey) {
      enteredReviewKeyRef.current = null;
      return;
    }
    if (enteredReviewKeyRef.current === authorityKey) return;
    enteredReviewKeyRef.current = authorityKey;
    void runPrepare(authorityKey);
  }, [authorityKey, draft.step]);

  const changeObjective = (objective: string): void => {
    if (objective === draft.objective) return;
    const currentFingerprint = missionRosterFingerprint(draft.roster);
    if (
      draft.roster.length > 0 &&
      automaticRosterFingerprintRef.current !== currentFingerprint
    ) {
      setRecommendationStale(true);
    }
    setObjective(objective);
  };

  const changeLane = (lane: MissionLane): void => {
    if (lane === draft.advanced.lane) return;
    const currentFingerprint = missionRosterFingerprint(draft.roster);
    const isAutomatic =
      automaticRosterFingerprintRef.current !== null &&
      automaticRosterFingerprintRef.current === currentFingerprint;
    if (draft.roster.length > 0 && !isAutomatic) {
      setRecommendationStale(true);
    }
    setAdvancedLane(lane);
    if (isAutomatic) {
      automaticRosterFingerprintRef.current = missionRosterFingerprint(
        useMissionSetupStore.getState().draft.roster,
      );
      setRecommendationStale(false);
    }
  };

  const changeRoster = (roster: readonly SquadAgent[]): void => {
    automaticRosterFingerprintRef.current = null;
    setRoster(roster);
  };

  const refreshRecommendedRoster = (): void => {
    const latestDraft = useMissionSetupStore.getState().draft;
    if (inventory.status !== 'ready' || !latestDraft.objective.trim()) return;
    const recommended = buildRecommendedMissionRoster({
      readiness: inventory.readiness,
      providers: inventory.providers,
      accounts: inventory.accounts,
      settings: inventory.settings,
      objective: latestDraft.objective,
      lane: latestDraft.advanced.lane,
    });
    if (!recommended) return;
    const recommendedFingerprint = missionRosterFingerprint(recommended);
    automaticRosterFingerprintRef.current = recommendedFingerprint;
    setRecommendationStale(false);
    if (
      recommendedFingerprint !==
      missionRosterFingerprint(latestDraft.roster)
    ) {
      setRoster(recommended);
    }
  };

  const discardSavedDraft = (): void => {
    automaticRosterFingerprintRef.current = null;
    setRecommendationStale(false);
    resetWorkspace();
  };

  const pickProjectFolder = async (): Promise<void> => {
    if (pickingWorkspaceRef.current) return;
    pickingWorkspaceRef.current = true;
    setPickingWorkspace(true);
    setWorkspaceActionError(null);
    try {
      await pickWorkspace();
    } catch {
      setWorkspaceActionError('Não foi possível abrir a pasta escolhida.');
    } finally {
      pickingWorkspaceRef.current = false;
      setPickingWorkspace(false);
    }
  };

  const leaveReview = (): void => {
    authorityGenerationRef.current += 1;
    startGenerationRef.current += 1;
    pendingPrepareKeyRef.current = null;
    pendingStartKeyRef.current = null;
    enteredReviewKeyRef.current = null;
    setReviewEnvelope(null);
    setPrepareStatus('idle');
    setStartStatus('idle');
    setReviewError(null);
    setStep('team');
  };

  const retryPrepare = (): void => {
    if (!authorityKey) return;
    void runPrepare(authorityKey);
  };

  const startMission = async (): Promise<void> => {
    if (
      !authorityKey ||
      !visibleReview ||
      prepareStatus !== 'ready' ||
      pendingStartKeyRef.current === authorityKey
    ) {
      return;
    }
    const currentSetup = useMissionSetupStore.getState();
    const currentWorkspace =
      useWorkspaceStore.getState().current?.path ?? null;
    const currentAuthorityKey = currentSetup.workspacePath
      ? `${currentSetup.workspacePath}\u0000${currentSetup.draft.revision}`
      : null;
    if (
      currentAuthorityKey !== authorityKey ||
      currentWorkspace !== currentSetup.workspacePath
    ) {
      return;
    }
    const capturedReview = visibleReview;
    const generation = ++startGenerationRef.current;
    pendingStartKeyRef.current = authorityKey;
    setStartStatus('loading');
    setReviewError(null);

    try {
      const snapshot = await window.nexus.mission.start({
        missionId: capturedReview.missionId,
        reviewSha256: capturedReview.reviewSha256,
      });
      const latestSetup = useMissionSetupStore.getState();
      const latestWorkspace = useWorkspaceStore.getState().current?.path ?? null;
      const latestKey = latestSetup.workspacePath
        ? `${latestSetup.workspacePath}\u0000${latestSetup.draft.revision}`
        : null;
      if (
        generation !== startGenerationRef.current ||
        latestKey !== authorityKey ||
        latestWorkspace !== latestSetup.workspacePath
      ) {
        return;
      }
      useProductNavigationStore.getState().openMission(snapshot.id);
    } catch {
      if (generation !== startGenerationRef.current) return;
      setReviewEnvelope(null);
      setPrepareStatus('error');
      setStartStatus('error');
      setReviewError(
        'A revisão pode ter ficado desatualizada e foi descartada. Prepare uma nova revisão antes de iniciar a missão.',
      );
    } finally {
      if (
        generation === startGenerationRef.current &&
        pendingStartKeyRef.current === authorityKey
      ) {
        pendingStartKeyRef.current = null;
        setStartStatus((status) => (status === 'loading' ? 'idle' : status));
      }
    }
  };

  if (workspacePath !== canonicalWorkspacePath) {
    return (
      <div className="mission-setup" aria-busy="true">
        <p className="mission-setup__status" role="status" aria-live="polite">
          Carregando o rascunho desta pasta…
        </p>
      </div>
    );
  }

  const currentStepIndex = STEP_LABELS.findIndex(
    ({ step }) => step === draft.step,
  );

  const currentStepLabel = STEP_LABELS[currentStepIndex]?.label ?? 'Missão';
  const persistenceNotice = missionSetupPersistenceMessage(persistence);


  return (
    <div className="mission-setup" data-step={draft.step}>
      <nav className="mission-setup__progress" aria-label="Etapas da missão">
        <ol>
          {STEP_LABELS.map(({ step, label }, index) => {
            const state =
              index === currentStepIndex
                ? 'current'
                : index < currentStepIndex
                  ? 'completed'
                  : 'available';
            return (
              <li
                key={step}
                data-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className="mission-setup__progress-label">{label}</span>
                <span className="mission-setup__progress-state">
                  {state === 'current'
                    ? 'Atual'
                    : state === 'completed'
                      ? 'Concluída'
                      : 'Disponível'}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>
      <p
        className="mission-setup__sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Etapa atual: {currentStepLabel}
      </p>

      {persistenceNotice && (
        <div
          ref={persistedDraftReadAlertRef}
          className="mission-setup__error-summary"
          role={hasUnreadDraft ? 'alert' : 'status'}
          aria-live={hasUnreadDraft ? undefined : 'polite'}
          aria-atomic="true"
          tabIndex={hasUnreadDraft ? -1 : undefined}
        >
          <strong>Rascunho somente na memória</strong>
          <span>{persistenceNotice}</span>
          <button
            type="button"
            className="mission-setup__button mission-setup__button--secondary"
            onClick={retryPersistence}
          >
            {persistence.status === 'error' &&
            persistence.operation === 'read'
              ? 'Tentar ler novamente'
              : 'Tentar salvar novamente'}
          </button>
          {persistence.status === 'error' &&
            persistence.operation === 'read' && (
              <button
                type="button"
                className="mission-setup__button mission-setup__button--secondary"
                onClick={discardSavedDraft}
              >
                Descartar rascunho salvo e começar vazio
              </button>
            )}
        </div>
      )}

      <div className="mission-setup__canvas">
        {draft.step === 'mission' && (
          <MissionStep
            workspace={workspace}
            draft={draft}
            draftFieldsDisabled={!workspace || hasUnreadDraft}
            suppressHeadingAutofocus={hasUnreadDraft}
            pickingWorkspace={pickingWorkspace}
            workspaceActionError={workspaceActionError}
            onPickWorkspace={() => void pickProjectFolder()}
            onObjectiveChange={changeObjective}
            onTitleChange={setTitle}
            onContextPathsChange={setContextPaths}
            onLaneChange={changeLane}
            onContinue={() => setStep('team')}
          />
        )}

        {draft.step === 'team' && (
          <TeamStep
            key={inventoryAttempt}
            roster={draft.roster}
            lane={draft.advanced.lane}
            recommendationStale={recommendationStale}
            revision={draft.revision}
            inventory={inventory}
            onRosterChange={changeRoster}
            onBack={() => setStep('mission')}
            onContinue={() => {
              if (inventoryReadyForReview) setStep('review');
            }}
            onRetryInventory={() =>
              setInventoryAttempt((attempt) => attempt + 1)
            }
            onRefreshRecommendation={refreshRecommendedRoster}
          />
        )}

        {draft.step === 'review' && (
          <ReviewStep
            review={visibleReview}
            lane={draft.advanced.lane}
            prepareStatus={prepareStatus}
            startStatus={startStatus}
            error={reviewError}
            onBack={leaveReview}
            onRetryPrepare={retryPrepare}
            onStart={() => void startMission()}
          />
        )}
      </div>
    </div>
  );
}
