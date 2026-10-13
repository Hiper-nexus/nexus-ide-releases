import { z } from 'zod';
import { create } from 'zustand';
import {
  clampMissionLaneTools,
  MISSION_INTENT_GOAL_MAX_CHARS,
  missionLaneSchema,
  missionIntentContractSchema,
  type MissionLane,
} from '../../shared/mission-intent';
import {
  strictSquadAgentSchema,
  type SquadAgent,
} from '../../shared/orch-types';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import { MISSION_PREPARE_TITLE_MAX_CHARS } from '../../shared/mission-engine-contract';
import { getActiveWorkspacePath } from './active-workspace';

export const MISSION_SETUP_DRAFT_VERSION = 1 as const;
/** Teto de integrantes de uma missão montada pelo rascunho. */
export const MISSION_SETUP_MAX_ROSTER = 12;
const MISSION_SETUP_STORAGE_PREFIX = 'nexus:mission-setup:draft:v1:';

export type MissionSetupStep = 'mission' | 'express' | 'team' | 'review';

export interface MissionSetupDraft {
  objective: string;
  /**
   * "Como vou saber que ficou pronto?" — o critério de aceite em linguagem de
   * gente. É campo tipado do contrato desde sempre (`missionIntentContract`)
   * e nunca teve um input: a missão nascia sem definição de pronto e o
   * princípio 7 perdia o elo do escopo.
   */
  acceptance?: string;
  title: string;
  contextPaths: string[];
  roster: SquadAgent[];
  advanced: { lane: MissionLane; freeAgentChoice?: boolean };
  step: MissionSetupStep;
  revision: number;
}
export interface PetStudioMissionSetupEntryContext {
  kind: 'pet-studio';
  origin: 'settings-appearance';
  objective: string;
  title: string;
  roster: SquadAgent[];
  profile: {
    kind: 'pet-studio';
    referenceImagePath: string;
  };
  step: 'review';
  revision: number;
}

export interface LegacyReplacementMissionSetupEntryContext {
  kind: 'legacy-replacement';
  supersededMissionId: string;
  acceptanceCriteria: string[];
}

export type MissionSetupEntryContext =
  | PetStudioMissionSetupEntryContext
  | LegacyReplacementMissionSetupEntryContext;

export interface BeginPetStudioReviewInput {
  objective: string;
  title: string;
  referenceImagePath: string;
}

export interface BeginLegacyReplacementReviewInput {
  workspacePath: string;
  supersededMissionId: string;
  objective: string;
  title: string;
  contextPaths: readonly string[];
  acceptanceCriteria: readonly string[];
  roster: readonly SquadAgent[];
  lane: MissionLane;
}


interface StoredMissionSetupDraft {
  version: typeof MISSION_SETUP_DRAFT_VERSION;
  workspacePath: string;
  draft: MissionSetupDraft;
}

export type MissionSetupPersistenceErrorReason =
  | 'storage-unavailable'
  | 'read-failed'
  | 'corrupt-payload'
  | 'unsupported-version'
  | 'invalid-payload'
  | 'quota-exceeded'
  | 'write-failed';

export type MissionSetupPersistenceState =
  | { status: 'idle' }
  | { status: 'empty' }
  | { status: 'saved' }
  | {
      status: 'error';
      operation: 'read' | 'write';
      reason: MissionSetupPersistenceErrorReason;
    };

export interface WorkspaceDraftMemory {
  draft: MissionSetupDraft;
  persistence: MissionSetupPersistenceState;
}

export interface MissionSetupStore {
  workspacePath: string | null;
  draft: MissionSetupDraft;
  persistence: MissionSetupPersistenceState;
  workspaceDrafts: Record<string, WorkspaceDraftMemory>;
  entryContext: MissionSetupEntryContext | null;
  entryAuthorityRevision: number;
  setWorkspace(workspacePath: string | null): void;
  setObjective(objective: string): void;
  setAcceptance(acceptance: string): void;
  setTitle(title: string): void;
  setContextPaths(contextPaths: readonly string[]): void;
  setRoster(roster: readonly SquadAgent[]): boolean;
  setAdvancedLane(lane: MissionLane): void;
  setFreeAgentChoice(freeAgentChoice: boolean): void;
  setStep(step: MissionSetupStep): void;
  beginPetStudioReview(
    input: BeginPetStudioReviewInput,
  ): PetStudioMissionSetupEntryContext | null;
  beginLegacyReplacementReview(
    input: BeginLegacyReplacementReviewInput,
  ): boolean;
  clearEntryContext(): void;
  /** Reseta o draft para vazio — usado ao abrir uma nova missão. */
  clearDraft(): void;
  /**
   * Começa uma missão nova no workspace ativo, no Caminho Expresso — a etapa
   * em que `createEmptyMissionSetupDraft` já nasce. Apaga rascunho persistido
   * (Equipe/Revisar) para o + Novo não reabrir a etapa seguinte da execução
   * anterior: a ETAPA nunca é herdada.
   *
   * Um objetivo já escrito NÃO é descartado. Dez portas chamam esta função e
   * reabrir a missão pelo único botão que o usuário reconhece não pode apagar
   * o texto dele. Quem precisa mesmo zerar passa `force` (é o que `clearDraft`
   * faz); `step` existe para a camada de operador entrar direto no wizard.
   */
  beginFreshMission(
    workspacePath?: string | null,
    options?: { force?: boolean; step?: MissionSetupStep },
  ): void;
  retryPersistence(): void;
  resetWorkspace(workspacePath?: string): void;
}

const missionSetupRosterAgentSchema = strictSquadAgentSchema.refine(
  (agent) => agent.ownsPlanDocs === undefined,
  'draft roster cannot carry planning authority',
);
const missionSetupContextPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (path) => normalizeProjectContextPath(path) === path,
    'context path must be canonical and root-relative',
  );


const missionSetupDraftSchema = z
  .object({
    objective: z.string().max(MISSION_INTENT_GOAL_MAX_CHARS),
    acceptance: z.string().max(2_048).default(''),
    title: z.string().max(MISSION_PREPARE_TITLE_MAX_CHARS),
    contextPaths: z
      .array(missionSetupContextPathSchema)
      .max(64)
      .refine(
        (paths) => new Set(paths).size === paths.length,
        'context paths must be unique',
      ),
    roster: z.array(missionSetupRosterAgentSchema).max(MISSION_SETUP_MAX_ROSTER),
    advanced: z
      .object({
        lane: missionLaneSchema,
        freeAgentChoice: z.boolean().optional(),
      })
      .strict(),
    step: z.enum(['mission', 'express', 'team', 'review']),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const storedMissionSetupDraftSchema = z
  .object({
    version: z.literal(MISSION_SETUP_DRAFT_VERSION),
    workspacePath: z.string().min(1).max(4_096),
    draft: missionSetupDraftSchema,
  })
  .strict();

const strictRosterSchema = z
  .array(missionSetupRosterAgentSchema)
  .max(MISSION_SETUP_MAX_ROSTER);

export function createEmptyMissionSetupDraft(
  revision = 0,
): MissionSetupDraft {
  return {
    objective: '',
    acceptance: '',
    title: '',
    contextPaths: [],
    roster: [],
    advanced: { lane: 'standard' },
    step: 'express',
    revision,
  };
}

export function missionSetupStorageKey(workspacePath: string): string {
  return `${MISSION_SETUP_STORAGE_PREFIX}${encodeURIComponent(workspacePath)}`;
}

/**
 * Accept only paths that stay inside the selected project. The main process
 * remains authoritative, but the draft never knowingly carries a host path.
 */
export function normalizeProjectContextPath(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed) ||
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\') ||
    /^(?:[a-z]:[\\/]|[\\/]{1,2})/iu.test(trimmed)
  ) {
    return null;
  }

  const normalized = trimmed.replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = normalized.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return null;
  }
  const projectPath = segments.join('/');
  return projectPath.length <= 4_096 ? projectPath : null;
}
function normalizedHostPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
}

export function isGovernedPetStudioReferencePath(
  referenceImagePath: string,
  workspacePath?: string | null,
): boolean {
  const image = normalizedHostPath(referenceImagePath);
  const absolute =
    image.startsWith('/') || /^[A-Za-z]:\//u.test(image);
  if (
    !absolute ||
    /[\u0000-\u001f\u007f]/u.test(image) ||
    image.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return false;
  }
  if (workspacePath) {
    const root = normalizedHostPath(workspacePath);
    return image.startsWith(`${root}/.nexus/attachments/`);
  }
  return image.includes('/.nexus/attachments/');
}

export function isExactPetStudioEntryContext(
  value: MissionSetupEntryContext | null | undefined,
  draft?: MissionSetupDraft,
  workspacePath?: string | null,
): value is PetStudioMissionSetupEntryContext {
  if (
    value?.kind !== 'pet-studio' ||
    value.origin !== 'settings-appearance' ||
    value.profile?.kind !== 'pet-studio' ||
    typeof value.profile.referenceImagePath !== 'string' ||
    value.step !== 'review' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.objective !== 'string' ||
    !value.objective.trim() ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    !isGovernedPetStudioReferencePath(
      value.profile.referenceImagePath,
      workspacePath,
    ) ||
    JSON.stringify(value.roster) !== JSON.stringify(PET_STUDIO_SQUAD.agents)
  ) {
    return false;
  }
  return (
    draft === undefined ||
    (draft.revision === value.revision &&
      draft.step === 'review' &&
      draft.objective === value.objective &&
      draft.title === value.title &&
      draft.contextPaths.length === 0 &&
      draft.advanced.lane === 'standard' &&
      JSON.stringify(draft.roster) ===
        JSON.stringify(PET_STUDIO_SQUAD.agents))
  );
}


function cloneAgent(agent: SquadAgent): SquadAgent {
  return {
    ...agent,
    ...(agent.allowedSkills === undefined
      ? {}
      : {
          allowedSkills:
            agent.allowedSkills === null ? null : [...agent.allowedSkills],
        }),
    ...(agent.allowedTools === undefined
      ? {}
      : {
          allowedTools:
            agent.allowedTools === null ? null : [...agent.allowedTools],
        }),
  };
}

function cloneAgentForLane(
  agent: SquadAgent,
  lane: MissionLane,
): SquadAgent {
  return {
    ...cloneAgent(agent),
    allowedTools: clampMissionLaneTools(
      lane,
      agent.category,
      agent.allowedTools,
    ),
  };
}

function cloneDraft(draft: MissionSetupDraft): MissionSetupDraft {
  return {
    ...draft,
    contextPaths: [...draft.contextPaths],
    roster: draft.roster.map(cloneAgent),
    advanced: { ...draft.advanced },
  };
}

/**
 * Ideia escrita antes de escolher a pasta: só texto (objetivo, aceite,
 * título e referências). Roster/equipe continuam por workspace e nunca
 * atravessam pastas — evita sugerir equipe da pasta errada.
 */
function draftTextFields(draft: MissionSetupDraft): {
  objective: string;
  acceptance?: string;
  title: string;
  contextPaths: string[];
} {
  return {
    objective: draft.objective,
    acceptance: draft.acceptance,
    title: draft.title,
    contextPaths: [...draft.contextPaths],
  };
}

function draftTextFieldsEmpty(draft: MissionSetupDraft): boolean {
  return (
    draft.objective.length === 0 &&
    (draft.acceptance ?? '').length === 0 &&
    draft.title.length === 0 &&
    draft.contextPaths.length === 0
  );
}

type StorageAccess =
  | { ok: true; value: Storage }
  | { ok: false };

interface WorkspaceDraftRead {
  draft: MissionSetupDraft;
  persistence: MissionSetupPersistenceState;
}

function persistenceError(
  operation: 'read' | 'write',
  reason: MissionSetupPersistenceErrorReason,
): MissionSetupPersistenceState {
  return { status: 'error', operation, reason };
}

function browserStorage(): StorageAccess {
  try {
    if (typeof window === 'undefined') return { ok: false };
    return { ok: true, value: window.localStorage };
  } catch {
    return { ok: false };
  }
}

function readWorkspaceDraft(workspacePath: string): WorkspaceDraftRead {
  const access = browserStorage();
  if (!access.ok) {
    return {
      draft: createEmptyMissionSetupDraft(),
      persistence: persistenceError('read', 'storage-unavailable'),
    };
  }

  let raw: string | null;
  try {
    raw = access.value.getItem(missionSetupStorageKey(workspacePath));
  } catch {
    return {
      draft: createEmptyMissionSetupDraft(),
      persistence: persistenceError('read', 'read-failed'),
    };
  }
  if (raw === null) {
    return {
      draft: createEmptyMissionSetupDraft(),
      persistence: { status: 'empty' },
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      draft: createEmptyMissionSetupDraft(),
      persistence: persistenceError('read', 'corrupt-payload'),
    };
  }

  if (
    decoded !== null &&
    typeof decoded === 'object' &&
    'version' in decoded &&
    decoded.version !== MISSION_SETUP_DRAFT_VERSION
  ) {
    return {
      draft: createEmptyMissionSetupDraft(),
      persistence: persistenceError('read', 'unsupported-version'),
    };
  }

  const parsed = storedMissionSetupDraftSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.workspacePath !== workspacePath) {
    return {
      draft: createEmptyMissionSetupDraft(),
      persistence: persistenceError('read', 'invalid-payload'),
    };
  }
  return {
    draft: cloneDraft(parsed.data.draft),
    persistence: { status: 'saved' },
  };
}

function persistWorkspaceDraft(
  workspacePath: string,
  draft: MissionSetupDraft,
): MissionSetupPersistenceState {
  const access = browserStorage();
  if (!access.ok) {
    return persistenceError('write', 'storage-unavailable');
  }
  const payload: StoredMissionSetupDraft = {
    version: MISSION_SETUP_DRAFT_VERSION,
    workspacePath,
    draft: cloneDraft(draft),
  };
  try {
    access.value.setItem(
      missionSetupStorageKey(workspacePath),
      JSON.stringify(payload),
    );
    return { status: 'saved' };
  } catch (cause) {
    const name =
      cause !== null &&
      typeof cause === 'object' &&
      'name' in cause &&
      typeof cause.name === 'string'
        ? cause.name
        : '';
    return persistenceError(
      'write',
      name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        ? 'quota-exceeded'
        : 'write-failed',
    );
  }
}

function normalizedContextPaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeProjectContextPath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length === 64) break;
  }
  return result;
}

export const useMissionSetupStore = create<MissionSetupStore>((set, get) => {
  const storeCurrentWorkspace = (
    draft: MissionSetupDraft,
    persistence: MissionSetupPersistenceState,
  ): void => {
    const current = get();
    const workspacePath = current.workspacePath;
    if (!workspacePath) return;
    set({
      draft,
      persistence,
      workspaceDrafts: {
        ...current.workspaceDrafts,
        [workspacePath]: { draft, persistence },
      },
    });
  };

  const replaceDraft = (
    update: (draft: MissionSetupDraft) => MissionSetupDraft,
  ): void => {
    const current = get();
    if (
      !current.workspacePath ||
      current.entryContext?.kind === 'pet-studio'
    ) {
      return;
    }
    const next = update(current.draft);
    storeCurrentWorkspace(
      next,
      persistWorkspaceDraft(current.workspacePath, next),
    );
  };

  const revise = (
    update: (draft: MissionSetupDraft) => Omit<MissionSetupDraft, 'revision'>,
  ): void => {
    replaceDraft((draft) => ({
      ...update(draft),
      revision: Math.min(Number.MAX_SAFE_INTEGER, draft.revision + 1),
    }));
  };

  /**
   * Revisão sem pasta: guarda a ideia só na memória (persistence idle),
   * sem tocar o localStorage. Usado pelos campos de texto antes da
   * escolha da pasta.
   */
  const revisePendingText = (
    update: (draft: MissionSetupDraft) => Omit<MissionSetupDraft, 'revision'>,
  ): void => {
    const current = get();
    if (current.entryContext?.kind === 'pet-studio') return;
    const next = {
      ...update(current.draft),
      revision: Math.min(
        Number.MAX_SAFE_INTEGER,
        current.draft.revision + 1,
      ),
    } as MissionSetupDraft;
    set({ draft: next, persistence: { status: 'idle' } });
  };

  return {
    workspacePath: null,
    draft: createEmptyMissionSetupDraft(),
    persistence: { status: 'idle' },
    workspaceDrafts: {},
    entryContext: null,
    entryAuthorityRevision: 0,

    setWorkspace: (workspacePath) => {
      const current = get();
      const entryAuthorityRevision = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.entryAuthorityRevision + 1,
      );
      if (workspacePath === current.workspacePath) return;

      let workspaceDrafts = current.workspaceDrafts;
      if (
        current.workspacePath &&
        current.entryContext?.kind !== 'pet-studio'
      ) {
        workspaceDrafts = {
          ...workspaceDrafts,
          [current.workspacePath]: {
            draft: current.draft,
            persistence: current.persistence,
          },
        };
      }

      if (!workspacePath) {
        // Sem pasta: a entrada é o Expresso e a ideia já escrita é
        // preservada na memória em vez de descartada. Nada é persistido
        // até uma pasta ser escolhida.
        //
        // `contextPaths` é a exceção: são caminhos de arquivo absolutos ou
        // relativos à árvore do workspace que está sendo fechado. Transportá-los
        // para o próximo projeto entrega a agentes cujo CWD é outro caminhos que
        // não existem lá (F-346). Texto viaja porque é visível e editável antes
        // de iniciar; caminho de arquivo não, porque o agente não tem como
        // perceber que é de outra árvore.
        const closingWorkspace = current.workspacePath !== null;
        const carried = closingWorkspace
          ? { ...current.draft, contextPaths: [] as string[] }
          : current.draft;
        const draft =
          carried.step === 'express'
            ? carried
            : {
                ...carried,
                step: 'express' as const,
                revision: Math.min(
                  Number.MAX_SAFE_INTEGER,
                  carried.revision + 1,
                ),
              };
        set({
          workspacePath: null,
          draft,
          persistence: { status: 'idle' },
          workspaceDrafts,
          entryContext: null,
          entryAuthorityRevision,
        });
        return;
      }

      // Ideia pendente (escrita sem pasta): viaja para a pasta escolhida. Se a
      // pasta já tem rascunho, os dois são mesclados — ver applyPending.
      const pending =
        !current.workspacePath && !draftTextFieldsEmpty(current.draft)
          ? draftTextFields(current.draft)
          : null;
      /** Junta dois textos não vazios sem perder nenhum dos dois. */
      const joinNonEmpty = (existing: string, incoming: string): string => {
        const a = existing.trim();
        const b = incoming.trim();
        if (!a) return incoming;
        if (!b) return existing;
        if (a === b) return existing;
        return `${existing.replace(/\s+$/, '')}\n\n${b}`;
      };
      const applyPending = (
        base: MissionSetupDraft,
      ): MissionSetupDraft => {
        if (!pending) return cloneDraft(base);
        const next = cloneDraft(base);
        if (draftTextFieldsEmpty(base)) {
          // Destino vazio: transferência integral.
          next.objective = pending.objective;
          next.acceptance = pending.acceptance;
          next.title = pending.title;
          next.contextPaths = [...pending.contextPaths];
        } else {
          // Destino com texto. A tela promete as duas coisas ao mesmo tempo —
          // "o texto acompanha sem apagar o rascunho que já existir nela" — e
          // antes só a segunda valia: o pending era descartado em silêncio, sem
          // toast e sem undo (F-345). Sobrescrever quebraria a outra metade.
          // Mesclar é o único desfecho que honra as duas.
          next.objective = joinNonEmpty(base.objective, pending.objective);
          next.acceptance = joinNonEmpty(
            base.acceptance ?? '',
            pending.acceptance ?? '',
          );
          // Título é rótulo, não prosa: concatenar produziria nonsense. O que já
          // existe vence; o pending só entra se não houver título.
          if (base.title.trim().length === 0) next.title = pending.title;
          next.contextPaths = [
            ...new Set([...base.contextPaths, ...pending.contextPaths]),
          ];
        }
        next.revision = Math.max(base.revision, current.draft.revision);
        return next;
      };

      const remembered = workspaceDrafts[workspacePath];
      if (remembered) {
        // applyPending mescla quando o destino tem texto e transfere quando está
        // vazio; sem pending devolve um clone, como antes.
        const draft = applyPending(remembered.draft);
        const persistence = pending
          ? persistWorkspaceDraft(workspacePath, draft)
          : remembered.persistence;
        set({
          workspacePath,
          draft,
          persistence,
          workspaceDrafts: {
            ...workspaceDrafts,
            [workspacePath]: { draft, persistence },
          },
          entryContext: null,
          entryAuthorityRevision,
        });
        return;
      }

      const loaded = readWorkspaceDraft(workspacePath);
      const draft = applyPending(loaded.draft);
      const persistence = pending
        ? persistWorkspaceDraft(workspacePath, draft)
        : loaded.persistence;
      set({
        workspacePath,
        draft,
        persistence,
        workspaceDrafts: {
          ...workspaceDrafts,
          [workspacePath]: { draft, persistence },
        },
        entryContext: null,
        entryAuthorityRevision,
      });
    },

    setObjective: (objective) => {
      const nextObjective = objective.slice(0, MISSION_INTENT_GOAL_MAX_CHARS);
      if (nextObjective === get().draft.objective) return;
      const update = (draft: MissionSetupDraft) => ({
        ...draft,
        objective: nextObjective,
      });
      if (get().workspacePath) revise(update);
      else revisePendingText(update);
    },

    setAcceptance: (acceptance) => {
      const next = acceptance.slice(0, 2_048);
      if (next === (get().draft.acceptance ?? '')) return;
      const update = (draft: MissionSetupDraft) => ({
        ...draft,
        acceptance: next,
      });
      if (get().workspacePath) revise(update);
      else revisePendingText(update);
    },

    setTitle: (title) => {
      const nextTitle = title.slice(0, MISSION_PREPARE_TITLE_MAX_CHARS);
      if (nextTitle === get().draft.title) return;
      const update = (draft: MissionSetupDraft) => ({
        ...draft,
        title: nextTitle,
      });
      if (get().workspacePath) revise(update);
      else revisePendingText(update);
    },

    setContextPaths: (contextPaths) => {
      const nextPaths = normalizedContextPaths(contextPaths);
      const currentPaths = get().draft.contextPaths;
      if (
        nextPaths.length === currentPaths.length &&
        nextPaths.every((path, index) => path === currentPaths[index])
      ) {
        return;
      }
      const update = (draft: MissionSetupDraft) => ({
        ...draft,
        contextPaths: nextPaths,
      });
      if (get().workspacePath) revise(update);
      else revisePendingText(update);
    },

    setRoster: (roster) => {
      // Autoridade de documento de plano (ownsPlanDocs) é main-owned e o
      // rascunho nunca a porta. Squads salvos legítimos a carregam
      // (builtins de plano e suas cópias de usuário), então a fronteira do
      // rascunho a REBAIXA em vez de recusar o roster inteiro: remover o
      // campo não concede nada, e toda ponte squad→rascunho (Configurações,
      // voz) fica coberta. O schema persistido continua recusando o campo.
      const downgraded = Array.isArray(roster)
        ? roster.map((agent) => {
            if (!agent || typeof agent !== 'object') return agent;
            const { ownsPlanDocs: _planAuthority, ...member } = agent;
            return member;
          })
        : roster;
      const parsed = strictRosterSchema.safeParse(downgraded);
      if (!parsed.success) return false;
      const lane = get().draft.advanced.lane;
      const nextRoster = parsed.data.map((agent) =>
        cloneAgentForLane(agent, lane),
      );
      revise((draft) => ({ ...draft, roster: nextRoster }));
      return true;
    },

    setAdvancedLane: (lane) => {
      if (lane === get().draft.advanced.lane) return;
      revise((draft) => ({
        ...draft,
        roster: draft.roster.map((agent) => cloneAgentForLane(agent, lane)),
        advanced: { ...draft.advanced, lane },
      }));
    },

    setFreeAgentChoice: (freeAgentChoice) => {
      if (freeAgentChoice === (get().draft.advanced.freeAgentChoice ?? false)) {
        return;
      }
      revise((draft) => ({
        ...draft,
        advanced: { ...draft.advanced, freeAgentChoice },
      }));
    },

    setStep: (step) => {
      if (step === get().draft.step) return;
      replaceDraft((draft) => ({ ...draft, step }));
    },
    beginPetStudioReview: (input) => {
      const current = get();
      const workspacePath = current.workspacePath;
      const objective = input.objective
        .trim()
        .slice(0, MISSION_INTENT_GOAL_MAX_CHARS);
      const title = input.title.trim().slice(0, MISSION_PREPARE_TITLE_MAX_CHARS);
      if (
        !workspacePath ||
        !objective ||
        !title ||
        !isGovernedPetStudioReferencePath(
          input.referenceImagePath,
          workspacePath,
        )
      ) {
        return null;
      }
      const revision = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(
          current.draft.revision,
          current.entryContext?.kind === 'pet-studio'
            ? current.entryContext.revision
            : 0,
        ) + 1,
      );
      const roster = PET_STUDIO_SQUAD.agents.map(cloneAgent);
      const draft: MissionSetupDraft = {
        objective,
        title,
        contextPaths: [],
        roster: roster.map(cloneAgent),
        advanced: { lane: 'standard' },
        step: 'review',
        revision,
      };
      const entryContext: PetStudioMissionSetupEntryContext = {
        kind: 'pet-studio',
        origin: 'settings-appearance',
        objective,
        title,
        roster,
        profile: {
          kind: 'pet-studio',
          referenceImagePath: normalizedHostPath(input.referenceImagePath),
        },
        step: 'review',
        revision,
      };
      const workspaceDrafts =
        current.entryContext?.kind === 'pet-studio'
          ? current.workspaceDrafts
          : {
              ...current.workspaceDrafts,
              [workspacePath]: {
                draft: cloneDraft(current.draft),
                persistence: current.persistence,
              },
            };
      set({
        draft,
        persistence: { status: 'idle' },
        workspaceDrafts,
        entryContext,
      });
      return entryContext;
    },

    beginLegacyReplacementReview: (input) => {
      const current = get();
      const roster = strictRosterSchema.safeParse(input.roster);
      const lane = missionLaneSchema.safeParse(input.lane);
      const acceptanceCriteria =
        missionIntentContractSchema.shape.acceptanceCriteria.safeParse(
          input.acceptanceCriteria,
        );
      const objective = input.objective
        .trim()
        .slice(0, MISSION_INTENT_GOAL_MAX_CHARS);
      const title = input.title.trim().slice(0, MISSION_PREPARE_TITLE_MAX_CHARS);
      const supersededMissionId = input.supersededMissionId.trim();
      if (
        current.workspacePath !== input.workspacePath ||
        !objective ||
        !title ||
        !supersededMissionId ||
        !roster.success ||
        roster.data.length < 2 ||
        !acceptanceCriteria.success ||
        !lane.success
      ) {
        return false;
      }
      const revision = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.draft.revision + 1,
      );
      const draft: MissionSetupDraft = {
        objective,
        title,
        contextPaths: normalizedContextPaths(input.contextPaths),
        roster: roster.data.map((agent) =>
          cloneAgentForLane(agent, lane.data),
        ),
        advanced: { lane: lane.data },
        step: 'review',
        revision,
      };
      const persistence = persistWorkspaceDraft(input.workspacePath, draft);
      set({
        draft,
        persistence,
        workspaceDrafts: {
          ...current.workspaceDrafts,
          [input.workspacePath]: { draft, persistence },
        },
        entryContext: {
          kind: 'legacy-replacement',
          supersededMissionId,
          acceptanceCriteria: [...acceptanceCriteria.data],
        },
      });
      return true;
    },

    beginFreshMission: (workspacePath, options) => {
      const current = get();
      const target =
        workspacePath ?? current.workspacePath ?? getActiveWorkspacePath();
      const empty = createEmptyMissionSetupDraft(
        Math.min(Number.MAX_SAFE_INTEGER, current.draft.revision + 1),
      );
      const keepObjective =
        !options?.force && current.draft.objective.trim().length > 0;
      // A etapa NUNCA atravessa: o + Novo não pode reabrir a Equipe da
      // execução anterior. Só o texto que a pessoa escreveu sobrevive.
      const draft: MissionSetupDraft = {
        ...empty,
        ...(keepObjective
          ? {
              objective: current.draft.objective,
              acceptance: current.draft.acceptance ?? '',
              title: current.draft.title,
              contextPaths: [...current.draft.contextPaths],
            }
          : {}),
        ...(options?.step ? { step: options.step } : {}),
      };
      const entryAuthorityRevision = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.entryAuthorityRevision + 1,
      );
      if (!target) {
        set({
          draft,
          persistence: { status: 'idle' },
          entryContext: null,
          entryAuthorityRevision,
        });
        return;
      }
      const persistence = persistWorkspaceDraft(target, draft);
      set({
        workspacePath: target,
        draft,
        persistence,
        workspaceDrafts: {
          ...current.workspaceDrafts,
          [target]: { draft, persistence },
        },
        entryContext: null,
        entryAuthorityRevision,
      });
    },
    clearDraft: () => {
      get().beginFreshMission(undefined, { force: true });
    },
    clearEntryContext: () => {
      const current = get();
      const entryAuthorityRevision = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.entryAuthorityRevision + 1,
      );
      if (!current.entryContext) {
        set({ entryAuthorityRevision });
        return;
      }
      const revision = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.draft.revision + 1,
      );
      if (current.entryContext.kind === 'pet-studio') {
        const remembered = current.workspacePath
          ? current.workspaceDrafts[current.workspacePath] ??
            readWorkspaceDraft(current.workspacePath)
          : null;
        const draft = remembered
          ? {
              ...cloneDraft(remembered.draft),
              revision: Math.max(remembered.draft.revision, revision),
            }
          : createEmptyMissionSetupDraft(revision);
        const persistence = current.workspacePath
          ? persistWorkspaceDraft(current.workspacePath, draft)
          : { status: 'idle' as const };
        set({
          draft,
          persistence,
          workspaceDrafts: current.workspacePath
            ? {
                ...current.workspaceDrafts,
                [current.workspacePath]: { draft, persistence },
              }
            : current.workspaceDrafts,
          entryContext: null,
          entryAuthorityRevision,
        });
        return;
      }
      const draft = { ...current.draft, revision };
      const persistence = current.workspacePath
        ? persistWorkspaceDraft(current.workspacePath, draft)
        : current.persistence;
      set({
        draft,
        persistence,
        workspaceDrafts: current.workspacePath
          ? {
              ...current.workspaceDrafts,
              [current.workspacePath]: { draft, persistence },
            }
          : current.workspaceDrafts,
        entryContext: null,
        entryAuthorityRevision,
      });
    },


    retryPersistence: () => {
      const current = get();
      if (!current.workspacePath || current.persistence.status !== 'error') {
        return;
      }
      if (current.persistence.operation === 'write') {
        storeCurrentWorkspace(
          current.draft,
          persistWorkspaceDraft(current.workspacePath, current.draft),
        );
        return;
      }

      const loaded = readWorkspaceDraft(current.workspacePath);
      storeCurrentWorkspace(loaded.draft, loaded.persistence);
    },

    resetWorkspace: (workspacePath) => {
      let current = get();
      const target = workspacePath ?? current.workspacePath;
      if (!target) return;
      if (target === current.workspacePath && current.entryContext) {
        current.clearEntryContext();
        current = get();
      }
      const previous =
        target === current.workspacePath
          ? current.draft
          : current.workspaceDrafts[target]?.draft ??
            readWorkspaceDraft(target).draft;
      const empty = createEmptyMissionSetupDraft(
        Math.min(Number.MAX_SAFE_INTEGER, previous.revision + 1),
      );
      const persistence = persistWorkspaceDraft(target, empty);
      const workspaceDrafts = {
        ...current.workspaceDrafts,
        [target]: { draft: empty, persistence },
      };
      if (target === current.workspacePath) {
        set({
          draft: empty,
          persistence,
          workspaceDrafts,
          entryContext: null,
        });
      } else {
        set({ workspaceDrafts });
      }
    },
  };
});
