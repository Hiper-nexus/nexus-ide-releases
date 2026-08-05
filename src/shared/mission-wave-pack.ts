/**
 * Mission Wave Pack — pure authority for Livre / Pack / Guiado.
 *
 * Pack turns an approved promoted plan with ≥2 BMAD stories into N disjoint
 * mutation tasks (topology `wave-pack`) so the scheduler can fan out panes.
 * See docs/design/mission-wave-pack.md.
 */

import { z } from "zod";
import type { MissionIntentRisk } from "./mission-intent";
import type { StandardMissionTopology } from "./mission-topology";
import {
  isWavePackTemplateId,
  storiesForWavePackTemplate,
  type WavePackTemplateId,
} from "./wave-pack-templates";

export const WAVE_PACK_DOMAIN = "wave-pack";

/**
 * Marker domain stamped on a story whose writer owns a real, disjoint file
 * subset (not the shared inventory merge-permit). Its presence flips the
 * scheduler from the shared-inventory shortcut to honest file-overlap checking,
 * so two disjoint writers fan out while a genuine same-file collision defers.
 */
export const WAVE_PACK_DISJOINT_FILES_DOMAIN = "wave-pack-disjoint-files";

export const MISSION_ORCHESTRATION_MODES = [
  "livre",
  "pack",
  "guided",
] as const;
export type MissionOrchestrationMode =
  (typeof MISSION_ORCHESTRATION_MODES)[number];

export const wavePackStorySchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    epicStoryId: z.string().trim().min(1).max(32),
    title: z.string().trim().min(1).max(256),
    body: z.string().max(8_192),
    /**
     * Optional disjoint file footprint for this story's writer. When present on
     * every story, Pack fans out with real file-level disjointness instead of
     * the shared-inventory merge permit. Omitted → legacy shared-inventory path.
     */
    ownershipFiles: z
      .array(z.string().trim().min(1).max(400))
      .max(256)
      .optional(),
  })
  .strict();

export type ExtractedWavePackStory = z.infer<typeof wavePackStorySchema>;

export const wavePackTemplateIdSchema = z.enum(["landing", "saas", "fix"]);


const STORY_HEADING_RE =
  /^(#{1,3})\s*Story\s+(\d+)\.(\d+)\s*:\s*(.+?)\s*$/gim;

/**
 * BMAD epics template uses `### Story N.M: title`. Standalone story files use
 * `# Story N.M: title`. Both are accepted; body runs until the next story
 * heading or end of document.
 */
export function extractStoriesFromPromotedPlanSummary(
  summary: string,
): readonly ExtractedWavePackStory[] {
  const text = summary.trim();
  if (!text) return Object.freeze([]);

  const matches = [...text.matchAll(STORY_HEADING_RE)];
  if (matches.length === 0) return Object.freeze([]);

  const stories: ExtractedWavePackStory[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const epic = match[2]!;
    const story = match[3]!;
    const title = match[4]!.trim().slice(0, 256);
    const start = (match.index ?? 0) + match[0]!.length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    const body = text.slice(start, end).trim().slice(0, 8_192);
    const epicStoryId = `${epic}.${story}`;
    stories.push(
      Object.freeze({
        id: `story-${epic}-${story}`,
        epicStoryId,
        title: title || `Story ${epicStoryId}`,
        body,
      }),
    );
  }
  return Object.freeze(stories);
}

/**
 * Canonical Pack stories: structured contract field wins; markdown summary is
 * fallback only (Wave 2).
 */
export function resolveWavePackStories(input: {
  readonly wavePackStories?: readonly ExtractedWavePackStory[] | null;
  readonly promotedPlanSummary?: string | null;
}): readonly ExtractedWavePackStory[] {
  if (input.wavePackStories && input.wavePackStories.length > 0) {
    return Object.freeze(
      input.wavePackStories.map((story) =>
        Object.freeze({ ...wavePackStorySchema.parse(story) }),
      ),
    );
  }
  const summary = input.promotedPlanSummary?.trim();
  if (!summary) return Object.freeze([]);
  return extractStoriesFromPromotedPlanSummary(summary);
}

/**
 * Freeze stories onto a contract at promote/compile time.
 * Explicit Pack template wins (operator chose declared fan-out); otherwise
 * markdown with ≥2 stories; thin markdown without template yields few/no stories.
 */
export function freezeWavePackStoriesForContract(input: {
  readonly summary?: string | null;
  readonly templateId?: WavePackTemplateId | null;
  readonly existingStories?: readonly ExtractedWavePackStory[] | null;
}): readonly ExtractedWavePackStory[] {
  if (input.existingStories && input.existingStories.length > 0) {
    return resolveWavePackStories({ wavePackStories: input.existingStories });
  }
  if (input.templateId && isWavePackTemplateId(input.templateId)) {
    return storiesForWavePackTemplate(input.templateId);
  }
  const fromMarkdown = input.summary?.trim()
    ? extractStoriesFromPromotedPlanSummary(input.summary)
    : Object.freeze([] as ExtractedWavePackStory[]);
  return fromMarkdown;
}

/**
 * Fail-closed: Pack requires ≥2 canonical stories before the contract is
 * stamped or sealed.
 */
export function assertWavePackStoriesReady(
  stories: readonly ExtractedWavePackStory[],
  context: string,
): void {
  if (stories.length < 2) {
    throw new Error(
      `wave_pack_insufficient_stories: ${context} — Pack exige ≥2 stories ` +
        "(BMAD no plano ou template Landing/SaaS/Fix)",
    );
  }
}

export function wavePackStoryDomain(storyId: string): string {
  const slug = storyId
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `wave-pack-story:${slug || "unknown"}`;
}

export function hasWavePackDomain(domains: readonly string[]): boolean {
  return domains.some(
    (domain) => domain.toLocaleLowerCase("en-US") === WAVE_PACK_DOMAIN,
  );
}

export function hasWavePackDisjointFilesDomain(
  domains: readonly string[],
): boolean {
  return domains.some(
    (domain) =>
      domain.toLocaleLowerCase("en-US") === WAVE_PACK_DISJOINT_FILES_DOMAIN,
  );
}

/**
 * Normalize a path for disjointness comparison: unify separators and strip a
 * leading `./`. Files stay case-sensitive (unlike domains) — a path collision
 * is what merges lose, and casing is significant on case-sensitive volumes.
 */
export function normalizeWavePackFile(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Fail-closed core invariant of the fan-out: no two disjoint-file story writers
 * may claim the same file. A shared file means two parallel worktrees mutate it
 * and the serial merge of the second one conflicts or silently loses a write.
 */
export function assertWavePackStoryFilesDisjoint(
  tasks: readonly {
    readonly plannerId: string;
    readonly ownership: { readonly files: readonly string[] };
  }[],
): void {
  const owners = new Map<string, string>();
  for (const task of tasks) {
    for (const raw of task.ownership.files) {
      const file = normalizeWavePackFile(raw);
      const previous = owners.get(file);
      if (previous !== undefined && previous !== task.plannerId) {
        throw new Error(
          `wave_pack_story_files_overlap: ${previous} e ${task.plannerId} ` +
            `disputam ${file} — stories paralelas exigem arquivos disjuntos`,
        );
      }
      owners.set(file, task.plannerId);
    }
  }
}

export type ResolveMissionOrchestrationModeInput = {
  readonly lane?: string | null;
  readonly risk: MissionIntentRisk;
  readonly hasPromotedPlan: boolean;
  readonly extractedStoryCount: number;
  /** Explicit operator override when the wizard gains the control (Wave 1). */
  readonly forcedMode?: MissionOrchestrationMode | null;
};

/**
 * Pure mode resolver. Destructive always stays guided (single writer) — even
 * when the operator forced Pack. Pack auto-select only with a promoted plan
 * and ≥2 stories; template/wizard Pack uses forcedMode.
 */
export function resolveMissionOrchestrationMode(
  input: ResolveMissionOrchestrationModeInput,
): MissionOrchestrationMode {
  // PREVC/single-writer floor for destructive work — never overridden by Pack.
  if (input.risk === "destructive") return "guided";
  if (input.forcedMode) return input.forcedMode;
  if ((input.lane ?? "standard") !== "standard") return "livre";
  if (input.hasPromotedPlan && input.extractedStoryCount >= 2) return "pack";
  return "guided";
}

export function topologyForOrchestrationMode(
  mode: MissionOrchestrationMode,
  fallback: StandardMissionTopology = "delivery",
): StandardMissionTopology {
  if (mode === "pack") return "wave-pack";
  if (mode === "livre" && fallback === "team-read-only-fanout") {
    return "team-read-only-fanout";
  }
  if (mode === "livre") return fallback;
  return "delivery";
}

export type WavePackExecutorRef = {
  readonly id: string;
  readonly agentName: string;
  readonly category: "executor";
};

export type WavePackReviewerRef = {
  readonly id: string;
  readonly agentName: string;
  readonly category: "reviewer";
};

export type WavePackPlannedTask = {
  readonly plannerId: string;
  readonly title: string;
  readonly detail: string;
  readonly agentRef: string;
  readonly category: "executor" | "reviewer";
  readonly executionMode: "isolated_worktree" | "read_only";
  readonly ownership: {
    readonly files: readonly string[];
    readonly symbols: readonly string[];
    readonly domains: readonly string[];
  };
  readonly dependsOn: readonly string[];
};

/**
 * Builds the Pack task graph. Story tasks are parallel roots (disjoint story
 * domains). Optional QA depends on every story planner id.
 */
export function planWavePackTasks(input: {
  readonly missionTitle: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly stories: readonly ExtractedWavePackStory[];
  readonly executors: readonly WavePackExecutorRef[];
  readonly qualityGate?: WavePackReviewerRef | null;
  /**
   * Scheduler wave concurrency hint only — never drops stories. Stories beyond
   * this cap still seal; they wait for free slots in later waves.
   */
  readonly maxWorkers: number;
  /** Mutation ownership files required by isolated_worktree seal/dispatch. */
  readonly ownershipFiles: readonly string[];
  /** Extra domains (e.g. repository-coverage) shared by every story root. */
  readonly ownershipCoverageDomains?: readonly string[];
}): readonly WavePackPlannedTask[] {
  if (input.stories.length < 2) {
    throw new Error(
      "wave_pack_insufficient_stories: Pack exige pelo menos 2 stories no plano promovido",
    );
  }
  if (input.executors.length === 0) {
    throw new Error(
      "wave_pack_executor_missing: o squad aprovado precisa de ao menos um executor",
    );
  }
  if (input.ownershipFiles.length === 0) {
    throw new Error(
      "wave_pack_ownership_missing: o inventário seguro do projeto está vazio",
    );
  }
  if (input.stories.length > 64) {
    throw new Error(
      "wave_pack_too_many_stories: o Pack suporta no máximo 64 stories seladas",
    );
  }

  const coverage = input.ownershipCoverageDomains ?? [];
  // Disjoint mode engages only when every story carves its own file footprint;
  // a partial declaration would fake disjointness against the shared inventory.
  const allStoriesDeclareFiles = input.stories.every(
    (story) => (story.ownershipFiles?.length ?? 0) > 0,
  );
  const storyTasks: WavePackPlannedTask[] = input.stories.map((story, index) => {
    const executor = input.executors[index % input.executors.length]!;
    const plannerId = `wave-pack-${story.id}`.slice(0, 128);
    const storyFiles =
      allStoriesDeclareFiles && story.ownershipFiles?.length
        ? story.ownershipFiles
        : input.ownershipFiles;
    const storyDomains =
      allStoriesDeclareFiles && story.ownershipFiles?.length
        ? [WAVE_PACK_DISJOINT_FILES_DOMAIN]
        : [];
    const detail = [
      `Implemente a story ${story.epicStoryId}: ${story.title}.`,
      "Você é um worker de mutação do Wave Pack: edite somente o necessário para esta story.",
      "Não implemente outras stories. Não reescreva o plano. Entregue handoff com arquivos tocados e como validar.",
      "",
      "Objetivo da missão:",
      input.goal,
      "",
      "Critérios de aceite da missão:",
      ...input.acceptanceCriteria.map(
        (criterion, criterionIndex) => `${criterionIndex + 1}. ${criterion}`,
      ),
      "",
      "Story:",
      story.body || `(sem corpo — título: ${story.title})`,
    ].join("\n");
    return Object.freeze({
      plannerId,
      title: `${story.epicStoryId} · ${story.title}`.slice(0, 1_024),
      detail,
      agentRef: executor.id,
      category: "executor" as const,
      executionMode: "isolated_worktree" as const,
      ownership: Object.freeze({
        files: Object.freeze([...storyFiles]),
        symbols: Object.freeze([] as string[]),
        domains: Object.freeze([
          "guided-implementation",
          WAVE_PACK_DOMAIN,
          wavePackStoryDomain(story.id),
          ...storyDomains,
          ...coverage,
        ]),
      }),
      dependsOn: Object.freeze([] as string[]),
    });
  });

  // Disjoint mode fans out real writers, so prove the core invariant before the
  // plan is sealed: no two story worktrees may claim the same file.
  if (allStoriesDeclareFiles) {
    assertWavePackStoryFilesDisjoint(storyTasks);
  }

  const tasks: WavePackPlannedTask[] = [...storyTasks];
  if (input.qualityGate) {
    const storyPlannerIds = storyTasks.map((task) => task.plannerId);
    tasks.push(
      Object.freeze({
        plannerId: "wave-pack-quality-gate",
        title: `QA · ${input.missionTitle}`.slice(0, 1_024),
        detail: [
          "Valide o pacote de stories do Wave Pack após a integração serial.",
          "Não reimplemente. Confira critérios de aceite e reporte falhas concretas.",
          "",
          "Objetivo da missão:",
          input.goal,
          "",
          "Stories cobertas:",
          ...input.stories.map(
            (story) => `- ${story.epicStoryId}: ${story.title}`,
          ),
        ].join("\n"),
        agentRef: input.qualityGate.id,
        category: "reviewer",
        executionMode: "read_only",
        ownership: Object.freeze({
          files: Object.freeze([] as string[]),
          symbols: Object.freeze([] as string[]),
          domains: Object.freeze([
            "guided-quality-gate",
            WAVE_PACK_DOMAIN,
            "sequential-only",
          ]),
        }),
        dependsOn: Object.freeze(storyPlannerIds),
      }),
    );
  }

  return Object.freeze(tasks);
}
