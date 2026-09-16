import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  missionPrepareRequestSchema,
  type MissionPrepareRequest,
  type MissionReview,
} from '../../../shared/mission-engine-contract';
import {
  clampMissionLaneTools,
  suggestMissionLaneFromGoal,
  type MissionLane,
} from '../../../shared/mission-intent';
import type { SquadAgent } from '../../../shared/orch-types';
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from '../../../shared/settings-types';
import { describeWorkspaceOpenError } from '../../lib/workspace-open-error';
import {
  requestDirectAnswer,
  type DirectAnswer,
} from '../../lib/direct-answer';
import { missionRuntimeReadiness } from '../../orch/mission-runtime-readiness';
import {
  isExactPetStudioEntryContext,
  type MissionSetupDraft,
  type MissionSetupEntryContext,
  type MissionSetupPersistenceState,
  type MissionSetupStep,
  type MissionSetupStore,
  useMissionSetupStore,
} from '../../state/mission-setup-store';
import { toUserFacingMissionError } from '../../lib/user-facing-mission-error';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { usePendingOrchestratorAdoptionStore } from '../../state/pending-orchestrator-adoption-store';
import { useProviderStore } from '../../state/provider-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { ExpressMissionStart } from './ExpressMissionStart';
import { MissionStep } from './MissionStep';
import {
  ReviewStep,
  type MissionPrepareStatus,
  type MissionStartStatus,
} from './ReviewStep';
import {
  buildRecommendedMissionRoster,
  issueForAgent,
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
  entryContext: MissionSetupEntryContext | null = null,
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
    advanced: {
      lane: draft.advanced.lane,
      ...(draft.advanced.freeAgentChoice ? { freeAgentChoice: true } : {}),
    },
    // O critério do operador vence: quando ele escreveu "como vou saber que
    // ficou pronto", é ISSO que sela o contrato. Sem ele, o critério herdado
    // de uma missão substituída continua valendo.
    ...(draft.acceptance?.trim()
      ? { acceptanceCriteria: [draft.acceptance.trim()] }
      : entryContext?.kind === 'legacy-replacement' &&
          entryContext.acceptanceCriteria.length > 0
        ? { acceptanceCriteria: [...entryContext.acceptanceCriteria] }
        : {}),
    ...(entryContext?.kind === 'pet-studio'
      ? {
          profile: {
            kind: 'pet-studio' as const,
            referenceImagePath: entryContext.profile.referenceImagePath,
          },
        }
      : {}),
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
function missionSetupAuthorityKey(
  state: Pick<
    MissionSetupStore,
    'workspacePath' | 'draft' | 'entryContext'
  >,
): string | null {
  if (!state.workspacePath) return null;
  const entry =
    state.entryContext?.kind === 'pet-studio'
      ? `${state.entryContext.kind}\u0000${state.entryContext.profile.referenceImagePath}\u0000${state.entryContext.revision}`
      : state.entryContext?.kind === 'legacy-replacement'
        ? `${state.entryContext.kind}\u0000${state.entryContext.supersededMissionId}\u0000${JSON.stringify(state.entryContext.acceptanceCriteria)}`
        : 'ordinary';
  return `${state.workspacePath}\u0000${state.draft.revision}\u0000${entry}`;
}
function discardPreparedReview(review: MissionReview): void {
  void window.nexus.orch?.removeMission(review.missionId).catch(() => undefined);
}

function isStaleReviewStartError(message: string): boolean {
  return /review fence|fence mismatch|fence is absent|desatualizad|prepar(ar|ação).*(mudou|descart)/i.test(
    message,
  );
}

function humanizeMissionStartError(message: string): string {
  const trimmed = message.trim();
  if (/kickoff-session_exited|terminal encerrou antes/i.test(trimmed)) {
    return 'O coordenador encerrou antes de aceitar o início. A missão foi preservada — abra-a e clique em Retomar.';
  }
  if (/kickoff-|materialization_failed|spawn_failed|provider_exited/i.test(trimmed)) {
    return 'O início da missão falhou ao subir o coordenador. A missão foi preservada com o diagnóstico real para retomar.';
  }
  if (/exclusive auth family/i.test(trimmed)) {
    return 'Já existe um coordenador vivo com a mesma conta. Encerre a sessão antiga ou aguarde a saída física antes de iniciar outra missão.';
  }
  // Sem passagem livre: qualquer diagnóstico cru de IPC, provider ou rede em
  // inglês ia inteiro para o role="alert" da tela onde a pessoa acabou de
  // escrever a ideia dela. O saneador da casa já remove stack, errno,
  // snake_case, URLs e caminhos.
  return toUserFacingMissionError(
    trimmed,
    'Não foi possível iniciar a missão. A preparação foi preservada quando seguro; abra a aba Atividade ou tente novamente.',
  );
}




export interface MissionSetupProps {
  /** Início opens Express; the advanced journey keeps its own destination. */
  home?: boolean;
}

export function MissionSetup({
  home = false,
}: MissionSetupProps = {}) {
  const workspace = useWorkspaceStore((state) => state.current);
  const pickWorkspace = useWorkspaceStore((state) => state.pick);
  const workspacePath = useMissionSetupStore((state) => state.workspacePath);
  const draft = useMissionSetupStore((state) => state.draft);
  const persistence = useMissionSetupStore((state) => state.persistence);
  const entryContext = useMissionSetupStore((state) => state.entryContext);
  const setWorkspace = useMissionSetupStore((state) => state.setWorkspace);
  const setObjective = useMissionSetupStore((state) => state.setObjective);
  const setAcceptance = useMissionSetupStore((state) => state.setAcceptance);
  const setTitle = useMissionSetupStore((state) => state.setTitle);
  const setContextPaths = useMissionSetupStore(
    (state) => state.setContextPaths,
  );
  const setRoster = useMissionSetupStore((state) => state.setRoster);
  const setAdvancedLane = useMissionSetupStore(
    (state) => state.setAdvancedLane,
  );
  const setFreeAgentChoice = useMissionSetupStore(
    (state) => state.setFreeAgentChoice,
  );
  const setStep = useMissionSetupStore((state) => state.setStep);
  const retryPersistence = useMissionSetupStore(
    (state) => state.retryPersistence,
  );
  const resetWorkspace = useMissionSetupStore(
    (state) => state.resetWorkspace,
  );
  const clearEntryContext = useMissionSetupStore(
    (state) => state.clearEntryContext,
  );
  const clearDraft = useMissionSetupStore((state) => state.clearDraft);

  const [inventoryAttempt, setInventoryAttempt] = useState(0);
  const [inventory, setInventory] = useState<MissionTeamInventory>(
    emptyInventory,
  );
  const liveProviders = useProviderStore((state) => state.providers);
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
  const [expressStatus, setExpressStatus] = useState<'idle' | 'loading'>(
    'idle',
  );
  const [expressError, setExpressError] = useState<string | null>(null);
  const expressBusyRef = useRef(false);
  /** Pergunta trivial respondida inline pelo router — nenhuma missão nasceu. */
  const [directAnswer, setDirectAnswer] = useState<DirectAnswer | null>(null);
  /** Bypass de 1 clique: "criar missão mesmo assim" não reclassifica. */
  const bypassDirectAnswerRef = useRef(false);

  const pickingWorkspaceRef = useRef(false);
  const authorityGenerationRef = useRef(0);
  const startGenerationRef = useRef(0);
  const pendingPrepareKeyRef = useRef<string | null>(null);
  const pendingStartKeyRef = useRef<string | null>(null);
  const enteredReviewKeyRef = useRef<string | null>(null);
  const startedReviewMissionIdRef = useRef<string | null>(null);
  const lastAuthorityKeyRef = useRef<string | null | undefined>(undefined);
  const automaticRosterFingerprintRef = useRef<string | null>(null);
  const recommendationWorkspaceRef = useRef<
    string | null | undefined
  >(undefined);
  const persistedDraftReadAlertRef = useRef<HTMLDivElement>(null);

  const canonicalWorkspacePath = workspace?.path ?? null;
  const petStudioReview = isExactPetStudioEntryContext(
    entryContext,
    draft,
    workspacePath,
  );
  const authorityKey = missionSetupAuthorityKey({
    workspacePath,
    draft,
    entryContext,
  });
  const visibleReview =
    reviewEnvelope && reviewEnvelope.authorityKey === authorityKey
      ? reviewEnvelope.review
      : null;
  const hasUnreadDraft =
    persistence.status === 'error' && persistence.operation === 'read';

  useLayoutEffect(() => {
    setWorkspace(canonicalWorkspacePath);
    if (home) setStep('express');
  }, [canonicalWorkspacePath, home, setStep, setWorkspace]);

  useLayoutEffect(() => {
    if (hasUnreadDraft) persistedDraftReadAlertRef.current?.focus();
  }, [hasUnreadDraft]);

  useEffect(() => {
    if (recommendationWorkspaceRef.current === workspacePath) return;
    recommendationWorkspaceRef.current = workspacePath;
    automaticRosterFingerprintRef.current = null;
    setRecommendationStale(false);
    setExpressError(null);
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

  // A foto inicial de `providers.list()` sai do cache frio, que reprova
  // credencial somente-Keychain (ex.: Claude). O main esquenta o cache e
  // re-transmite; o store vivo recebe. Sem esta reconciliação o readiness
  // fica preso na foto errada até o operador tentar de novo.
  useEffect(() => {
    if (liveProviders.length === 0) return;
    setInventory((current) => {
      if (current.status === 'loading') return current;
      if (
        JSON.stringify(current.providers) === JSON.stringify(liveProviders)
      ) {
        return current;
      }
      return {
        ...current,
        providers: liveProviders,
        readiness: missionRuntimeReadiness(
          current.adapters,
          liveProviders,
          current.accounts,
          current.settings.squadCliPolicy,
        ),
      };
    });
  }, [liveProviders]);

  useEffect(() => {
    if (
      entryContext !== null ||
      !workspacePath ||
      hasUnreadDraft ||
      inventory.status !== 'ready'
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
    entryContext,
    hasUnreadDraft,
    inventory,
    setRoster,
    workspacePath,
  ]);

  useEffect(() => {
    const invalidPetReview =
      entryContext?.kind === 'pet-studio' && !petStudioReview;
    if (lastAuthorityKeyRef.current === undefined) {
      lastAuthorityKeyRef.current = authorityKey;
      if (invalidPetReview) {
        clearEntryContext();
        useProductNavigationStore
          .getState()
          .returnToSettingsSection('pets');
      }
      return;
    }
    if (lastAuthorityKeyRef.current === authorityKey) return;

    lastAuthorityKeyRef.current = authorityKey;
    authorityGenerationRef.current += 1;
    startGenerationRef.current += 1;
    pendingPrepareKeyRef.current = null;
    pendingStartKeyRef.current = null;
    enteredReviewKeyRef.current =
      draft.step === 'review' && !petStudioReview ? authorityKey : null;
    setReviewEnvelope(null);
    setPrepareStatus('idle');
    setStartStatus('idle');
    setExpressStatus('idle');
    expressBusyRef.current = false;
    if (
      reviewEnvelope &&
      reviewEnvelope.authorityKey !== authorityKey &&
      reviewEnvelope.review.missionId !== startedReviewMissionIdRef.current
    ) {
      discardPreparedReview(reviewEnvelope.review);
    }
    setReviewError(null);
    if (invalidPetReview) {
      clearEntryContext();
      useProductNavigationStore
        .getState()
        .returnToSettingsSection('pets');
      return;
    }
    if (draft.step === 'review' && !petStudioReview) setStep('team');
  }, [
    authorityKey,
    clearEntryContext,
    draft.step,
    entryContext,
    petStudioReview,
    setStep,
  ]);

  const inventoryReadyForReview =
    inventory.status === 'ready' &&
    inventory.readiness.hasOperationalRoute;

  const runPrepare = async (capturedAuthorityKey: string): Promise<void> => {
    if (pendingPrepareKeyRef.current === capturedAuthorityKey) return;
    const setupState = useMissionSetupStore.getState();
    const currentWorkspacePath =
      useWorkspaceStore.getState().current?.path ?? null;
    const currentKey = missionSetupAuthorityKey(setupState);
    if (
      currentKey !== capturedAuthorityKey ||
      currentWorkspacePath !== setupState.workspacePath
    ) {
      return;
    }
    if (
      setupState.entryContext?.kind === 'pet-studio' &&
      !isExactPetStudioEntryContext(
        setupState.entryContext,
        setupState.draft,
        setupState.workspacePath,
      )
    ) {
      setReviewEnvelope(null);
      setPrepareStatus('error');
      setReviewError(
        'A autoridade fixa do Pet Studio mudou. Volte para Aparência e selecione a imagem novamente.',
      );
      return;
    }


    const requestResult = missionPrepareRequestSchema.safeParse(
      missionPrepareRequestFromDraft(
        setupState.draft,
        setupState.entryContext,
      ),
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
      const latestKey = missionSetupAuthorityKey(latestSetup);
      if (
        generation !== authorityGenerationRef.current ||
        latestKey !== capturedAuthorityKey ||
        latestWorkspace !== latestSetup.workspacePath
      ) {
        discardPreparedReview(review);
        return;
      }
      setReviewEnvelope({ authorityKey: capturedAuthorityKey, review });
      startedReviewMissionIdRef.current = null;
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
    if (home || draft.step !== 'review' || !authorityKey) {
      enteredReviewKeyRef.current = null;
      return;
    }
    if (enteredReviewKeyRef.current === authorityKey) return;
    enteredReviewKeyRef.current = authorityKey;
    void runPrepare(authorityKey);
  }, [authorityKey, draft.step, home]);

  const changeObjective = (objective: string): void => {
    if (objective === draft.objective) return;
    setExpressError(null);
    // Objetivo novo invalida a resposta inline — ela era da pergunta anterior.
    setDirectAnswer(null);
    bypassDirectAnswerRef.current = false;
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
    setExpressError(null);
    try {
      await pickWorkspace();
    } catch (cause) {
      setWorkspaceActionError(describeWorkspaceOpenError(cause));
    } finally {
      pickingWorkspaceRef.current = false;
      setPickingWorkspace(false);
    }
  };

  const leaveReview = (): void => {
    authorityGenerationRef.current += 1;
    startGenerationRef.current += 1;
    pendingPrepareKeyRef.current = null;
    if (
      visibleReview &&
      visibleReview.missionId !== startedReviewMissionIdRef.current
    ) {
      discardPreparedReview(visibleReview);
    }
    pendingStartKeyRef.current = null;
    enteredReviewKeyRef.current = null;
    setReviewEnvelope(null);
    setPrepareStatus('idle');
    setStartStatus('idle');
    setReviewError(null);
    if (entryContext?.kind === 'pet-studio') {
      clearEntryContext();
      useProductNavigationStore
        .getState()
        .returnToSettingsSection('pets');
      return;
    }
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
    const currentAuthorityKey = missionSetupAuthorityKey(currentSetup);
    const currentDestination =
      useProductNavigationStore.getState().destination;
    if (
      currentAuthorityKey !== authorityKey ||
      currentWorkspace !== currentSetup.workspacePath ||
      currentDestination.kind !== 'mission-setup'
    ) {
      return;
    }
    const capturedReview = visibleReview;
    const capturedSupersededMissionId =
      currentSetup.entryContext?.kind === 'legacy-replacement'
        ? currentSetup.entryContext.supersededMissionId
        : null;
    const generation = ++startGenerationRef.current;
    pendingStartKeyRef.current = authorityKey;
    startedReviewMissionIdRef.current = capturedReview.missionId;
    setStartStatus('loading');
    setReviewError(null);

    let startSucceeded = false;
    try {
      // Adoção (F-561): se o operador marcou um painel para liderar, a missão
      // nasce COM ele — o motor não sobe um Maestro em branco. `take()` é de um
      // uso só: um start falho não deixa a marca pendurada para a próxima.
      const adopted = usePendingOrchestratorAdoptionStore.getState().take();
      const snapshot = await window.nexus.mission.start({
        missionId: capturedReview.missionId,
        reviewSha256: capturedReview.reviewSha256,
        ...(adopted ? { adoptOrchestratorPaneId: adopted.paneId } : {}),
      });
      startSucceeded = true;
      if (capturedSupersededMissionId) {
        await window.nexus.orch.removeMission(capturedSupersededMissionId);
      }

      const latestSetup = useMissionSetupStore.getState();
      const latestWorkspace = useWorkspaceStore.getState().current?.path ?? null;
      const latestKey = missionSetupAuthorityKey(latestSetup);
      const latestDestination =
        useProductNavigationStore.getState().destination;
      if (
        generation !== startGenerationRef.current ||
        latestKey !== authorityKey ||
        latestWorkspace !== latestSetup.workspacePath ||
        latestDestination.kind !== 'mission-setup'
      ) {
        return;
      }
      clearEntryContext();
      // O rascunho já virou missão: preservá-lo faria o próximo + Novo abrir
      // o Expresso pré-preenchido com o objetivo da missão em execução, a um
      // clique de despachar uma duplicata na mesma pasta.
      clearDraft();
      useProductNavigationStore.getState().openMission(snapshot.id);
    } catch (error) {
      const rawMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : '';
      const staleReview = isStaleReviewStartError(rawMessage);
      const leftSetup =
        useProductNavigationStore.getState().destination.kind !==
        'mission-setup';
      if (!startSucceeded) {
        if (
          startedReviewMissionIdRef.current === capturedReview.missionId
        ) {
          startedReviewMissionIdRef.current = null;
        }
        // Discard the prepared review when the fence is stale, or when the
        // operator already left Setup during a deferred start — otherwise the
        // unused replacement leaks while the legacy shell stays on screen.
        // Kickoff/provider failures while still on Setup leave a durable
        // blocked mission the operator can open and resume.
        if (staleReview || leftSetup) {
          discardPreparedReview(capturedReview);
        }
      }
      if (generation !== startGenerationRef.current) return;
      // Operator already left Setup: do not steal navigation or mutate the
      // setup UI underneath Terminal/Board.
      if (leftSetup) return;
      setReviewEnvelope(null);
      if (startSucceeded) {
        setPrepareStatus('error');
        setStartStatus('error');
        setReviewError(
          'A missão iniciou, mas a substituição da missão anterior não pôde ser concluída.',
        );
        return;
      }
      if (staleReview) {
        setPrepareStatus('error');
        setStartStatus('error');
        setReviewError(
          'A revisão pode ter ficado desatualizada e foi descartada. Prepare uma nova revisão antes de iniciar a missão.',
        );
        return;
      }
      setPrepareStatus('idle');
      setStartStatus('error');
      setReviewError(humanizeMissionStartError(rawMessage));
      useProductNavigationStore
        .getState()
        .openMission(capturedReview.missionId);
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

  const startExpress = async (): Promise<void> => {
    if (expressBusyRef.current) return;
    const setupState = useMissionSetupStore.getState();
    const capturedDestination = home ? 'launcher' : 'mission-setup';
    const capturedEntryRevision = setupState.entryAuthorityRevision;
    const isCurrentCreationEntry = (): boolean =>
      useProductNavigationStore.getState().destination.kind === capturedDestination &&
      useMissionSetupStore.getState().entryAuthorityRevision === capturedEntryRevision;
    if (!isCurrentCreationEntry()) return;
    const currentWorkspacePath =
      useWorkspaceStore.getState().current?.path ?? null;
    if (
      !currentWorkspacePath ||
      setupState.workspacePath !== currentWorkspacePath
    ) {
      void pickProjectFolder();
      return;
    }
    if (!setupState.draft.objective.trim()) {
      setExpressError('Descreva o que você quer que a missão entregue.');
      return;
    }
    // Router de intenção (Onda 3): pergunta pura é respondida inline por um
    // provedor barato já configurado — nenhuma missão, squad ou pane nasce
    // para "quanto é 1+1?". Fail-open: sem resposta, o fluxo normal segue.
    if (!bypassDirectAnswerRef.current) {
      expressBusyRef.current = true;
      setExpressStatus('loading');
      setExpressError(null);
      const direct = await requestDirectAnswer(setupState.draft.objective);
      expressBusyRef.current = false;
      setExpressStatus('idle');
      if (!isCurrentCreationEntry()) return;
      if (direct) {
        setDirectAnswer(direct);
        return;
      }
    }
    bypassDirectAnswerRef.current = false;
    if (!inventoryReadyForReview) {
      setExpressError(
        inventory.status === 'loading'
          ? 'Aguarde a verificação das ferramentas de IA conectadas.'
          : inventory.status === 'error'
            ? 'Não foi possível verificar suas ferramentas de IA. Tente novamente em instantes.'
            : 'Falta conectar uma ferramenta de IA — use o botão “Conectar uma ferramenta de IA” logo acima.',
      );
      return;
    }
    // A lane vem do OBJETIVO, não de um padrão fixo. O Expresso é o caminho
    // default de quem não programa e fixava `standard`: uma missão que dizia
    // "só o plano, sem escrever código" rodava como implementação e o
    // coordenador abria trabalhadores para escrever código — o oposto do
    // pedido (voo real 23/08). `suggestMissionLaneFromGoal` já existia e
    // tinha ZERO consumidores no renderer.
    const expressLane =
      suggestMissionLaneFromGoal(setupState.draft.objective) ?? 'standard';
    // Releitura depois do router de intenção: o operador pode ter trocado a
    // Ferramenta enquanto a pergunta trivial era avaliada.
    const latestDraft = useMissionSetupStore.getState().draft;
    const operatorRoster = latestDraft.roster;
    const roster =
      operatorRoster.length > 0
        ? operatorRoster
        : buildRecommendedMissionRoster({
            readiness: inventory.readiness,
            providers: inventory.providers,
            accounts: inventory.accounts,
            settings: inventory.settings,
            objective: latestDraft.objective,
            lane: expressLane,
          });
    if (!roster || roster.length === 0) {
      setExpressError(
        'Não foi possível montar a equipe. Escolha as ferramentas acima ou use Mais papéis e tamanho.',
      );
      return;
    }
    const maestro = roster.find((agent) => agent.category === 'orchestrator');
    if (maestro && inventory.status === 'ready') {
      const issue = issueForAgent(maestro, inventory);
      if (issue) {
        setExpressError(issue);
        return;
      }
    }
    // Override local do draft — NUNCA setRoster/setFreeAgentChoice no store:
    // ambos bumpam `revision` → `authorityKey` muda → o efeito de autoridade
    // invalida o start em voo. O request enviado usa o roster que está na
    // tela (Ferramenta/Modelo de cada papel) e o modo livre só nesta chamada.
    const expressDraft: MissionSetupDraft = {
      ...latestDraft,
      roster,
      advanced: { lane: expressLane, freeAgentChoice: true },
    };
    const requestResult = missionPrepareRequestSchema.safeParse(
      missionPrepareRequestFromDraft(expressDraft, setupState.entryContext),
    );
    if (!requestResult.success) {
      setExpressError('Revise o objetivo antes de tentar novamente.');
      return;
    }
    const capturedAuthorityKey = authorityKey;
    if (!capturedAuthorityKey) return;

    const generation = ++startGenerationRef.current;
    expressBusyRef.current = true;
    setExpressStatus('loading');
    setExpressError(null);

    try {
      const review = await window.nexus.mission.prepare(requestResult.data);
      const latestSetup = useMissionSetupStore.getState();
      const latestWorkspace =
        useWorkspaceStore.getState().current?.path ?? null;
      const latestKey = missionSetupAuthorityKey(latestSetup);
      if (
        !isCurrentCreationEntry() ||
        generation !== startGenerationRef.current ||
        latestKey !== capturedAuthorityKey ||
        latestWorkspace !== latestSetup.workspacePath ||
        latestSetup.draft.step !== 'express'
      ) {
        discardPreparedReview(review);
        return;
      }
      const adopted = usePendingOrchestratorAdoptionStore.getState().take();
      const snapshot = await window.nexus.mission.start({
        missionId: review.missionId,
        reviewSha256: review.reviewSha256,
        ...(adopted ? { adoptOrchestratorPaneId: adopted.paneId } : {}),
      });
      const finalSetup = useMissionSetupStore.getState();
      const finalWorkspace = useWorkspaceStore.getState().current?.path ?? null;
      const finalKey = missionSetupAuthorityKey(finalSetup);
      if (
        !isCurrentCreationEntry() ||
        generation !== startGenerationRef.current ||
        finalKey !== capturedAuthorityKey ||
        finalWorkspace !== finalSetup.workspacePath ||
        finalSetup.draft.step !== 'express'
      ) {
        return;
      }
      clearEntryContext();
      // O rascunho já virou missão: preservá-lo faria o próximo + Novo abrir
      // o Expresso pré-preenchido com o objetivo da missão em execução, a um
      // clique de despachar uma duplicata na mesma pasta.
      clearDraft();
      useProductNavigationStore.getState().openMission(snapshot.id);
    } catch (error) {
      if (generation !== startGenerationRef.current) return;
      const rawMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : '';
      if (!isCurrentCreationEntry()) return;
      setExpressStatus('idle');
      setExpressError(humanizeMissionStartError(rawMessage));
    } finally {
      if (generation === startGenerationRef.current) {
        expressBusyRef.current = false;
        setExpressStatus((status) => (status === 'loading' ? 'idle' : status));
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
      {draft.step !== 'express' && (
        <>
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
                    <span
                      className="mission-setup__progress-dot"
                      aria-hidden="true"
                    >
                      {state === 'completed' ? '✓' : index + 1}
                    </span>
                    <span className="mission-setup__progress-label">
                      {label}
                    </span>
                    <span className="mission-setup__progress-state mission-setup__sr-only">
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
        </>
      )}

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
        {draft.step === 'express' && (
          <ExpressMissionStart
            workspace={workspace}
            draft={draft}
            draftFieldsDisabled={hasUnreadDraft}
            suppressHeadingAutofocus={hasUnreadDraft}
            pickingWorkspace={pickingWorkspace}
            workspaceActionError={workspaceActionError}
            inventoryReady={inventoryReadyForReview}
            inventoryLoading={inventory.status === 'loading'}
            busy={expressStatus === 'loading'}
            error={expressError}
            directAnswer={directAnswer}
            onDismissDirectAnswer={() => setDirectAnswer(null)}
            onStartMissionAnyway={() => {
              bypassDirectAnswerRef.current = true;
              setDirectAnswer(null);
              void startExpress();
            }}
            onPickWorkspace={() => void pickProjectFolder()}
            onObjectiveChange={changeObjective}
            onAcceptanceChange={(value) => setAcceptance(value)}
            onContextPathsChange={setContextPaths}
            onStart={() => void startExpress()}
            onAdvanced={() => {
              if (home) useProductNavigationStore.getState().openMissionSetup();
              setStep('team');
            }}
            onConnectProvider={() =>
              useProductNavigationStore.getState().openSettings('providers')
            }
            inventory={inventory}
            onRosterChange={changeRoster}
          />
        )}

        {draft.step === 'mission' && (
          <MissionStep
            workspace={workspace}
            draft={draft}
            draftFieldsDisabled={hasUnreadDraft}
            suppressHeadingAutofocus={hasUnreadDraft}
            pickingWorkspace={pickingWorkspace}
            workspaceActionError={workspaceActionError}
            onPickWorkspace={() => void pickProjectFolder()}
            onObjectiveChange={changeObjective}
            onTitleChange={setTitle}
            onContextPathsChange={setContextPaths}
            onLaneChange={changeLane}
            onFreeAgentChoiceChange={setFreeAgentChoice}
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
            entryContext={entryContext}
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
            backLabel={
              entryContext?.kind === 'pet-studio'
                ? 'Voltar para aparência'
                : undefined
            }
            onBack={leaveReview}
            onRetryPrepare={retryPrepare}
            onStart={() => void startMission()}
          />
        )}
      </div>
    </div>
  );
}
