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

export const MISSION_SETUP_DRAFT_VERSION = 1 as const;
const MISSION_SETUP_STORAGE_PREFIX = 'nexus:mission-setup:draft:v1:';

export type MissionSetupStep = 'mission' | 'team' | 'review';

export interface MissionSetupDraft {
  objective: string;
  title: string;
  contextPaths: string[];
  roster: SquadAgent[];
  advanced: { lane: MissionLane };
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
  setTitle(title: string): void;
  setContextPaths(contextPaths: readonly string[]): void;
  setRoster(roster: readonly SquadAgent[]): void;
  setAdvancedLane(lane: MissionLane): void;
  setStep(step: MissionSetupStep): void;
  beginPetStudioReview(
    input: BeginPetStudioReviewInput,
  ): PetStudioMissionSetupEntryContext | null;
  beginLegacyReplacementReview(
    input: BeginLegacyReplacementReviewInput,
  ): boolean;
  clearEntryContext(): void;
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
    title: z.string().max(MISSION_PREPARE_TITLE_MAX_CHARS),
    contextPaths: z
      .array(missionSetupContextPathSchema)
      .max(64)
      .refine(
        (paths) => new Set(paths).size === paths.length,
        'context paths must be unique',
      ),
    roster: z.array(missionSetupRosterAgentSchema).max(12),
    advanced: z.object({ lane: missionLaneSchema }).strict(),
    step: z.enum(['mission', 'team', 'review']),
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

const strictRosterSchema = z.array(missionSetupRosterAgentSchema).max(12);

export function createEmptyMissionSetupDraft(
  revision = 0,
): MissionSetupDraft {
  return {
    objective: '',
    title: '',
    contextPaths: [],
    roster: [],
    advanced: { lane: 'standard' },
    step: 'mission',
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
        set({
          workspacePath: null,
          draft: createEmptyMissionSetupDraft(
            Math.min(Number.MAX_SAFE_INTEGER, current.draft.revision + 1),
          ),
          persistence: { status: 'idle' },
          workspaceDrafts,
          entryContext: null,
          entryAuthorityRevision,
        });
        return;
      }

      const remembered = workspaceDrafts[workspacePath];
      if (remembered) {
        set({
          workspacePath,
          draft: cloneDraft(remembered.draft),
          persistence: remembered.persistence,
          workspaceDrafts,
          entryContext: null,
          entryAuthorityRevision,
        });
        return;
      }

      const loaded = readWorkspaceDraft(workspacePath);
      set({
        workspacePath,
        draft: loaded.draft,
        persistence: loaded.persistence,
        workspaceDrafts: {
          ...workspaceDrafts,
          [workspacePath]: loaded,
        },
        entryContext: null,
        entryAuthorityRevision,
      });
    },

    setObjective: (objective) => {
      const nextObjective = objective.slice(0, MISSION_INTENT_GOAL_MAX_CHARS);
      if (nextObjective === get().draft.objective) return;
      revise((draft) => ({ ...draft, objective: nextObjective }));
    },

    setTitle: (title) => {
      const nextTitle = title.slice(0, MISSION_PREPARE_TITLE_MAX_CHARS);
      if (nextTitle === get().draft.title) return;
      revise((draft) => ({ ...draft, title: nextTitle }));
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
      revise((draft) => ({ ...draft, contextPaths: nextPaths }));
    },

    setRoster: (roster) => {
      const parsed = strictRosterSchema.safeParse(roster);
      if (!parsed.success) return;
      const lane = get().draft.advanced.lane;
      const nextRoster = parsed.data.map((agent) =>
        cloneAgentForLane(agent, lane),
      );
      revise((draft) => ({ ...draft, roster: nextRoster }));
    },

    setAdvancedLane: (lane) => {
      if (lane === get().draft.advanced.lane) return;
      revise((draft) => ({
        ...draft,
        roster: draft.roster.map((agent) => cloneAgentForLane(agent, lane)),
        advanced: { lane },
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
