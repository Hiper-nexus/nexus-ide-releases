/**
 * Mission Wave Pack — pure authority for Livre / Pack / Guiado.
 *
 * Pack turns an approved promoted plan with ≥2 BMAD stories into N disjoint
 * mutation tasks (topology `wave-pack`) so the scheduler can fan out panes.
 * See docs/design/mission-wave-pack.md.
 */

import type { MissionIntentRisk } from "./mission-intent";
import type { StandardMissionTopology } from "./mission-topology";

export const WAVE_PACK_DOMAIN = "wave-pack";

export const MISSION_ORCHESTRATION_MODES = [
  "livre",
  "pack",
  "guided",
] as const;
export type MissionOrchestrationMode =
  (typeof MISSION_ORCHESTRATION_MODES)[number];

export type ExtractedWavePackStory = {
  readonly id: string;
  readonly epicStoryId: string;
  readonly title: string;
  readonly body: string;
};

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

export type ResolveMissionOrchestrationModeInput = {
  readonly lane?: string | null;
  readonly risk: MissionIntentRisk;
  readonly hasPromotedPlan: boolean;
  readonly extractedStoryCount: number;
  /** Explicit operator override when the wizard gains the control (Wave 1). */
  readonly forcedMode?: MissionOrchestrationMode | null;
};

/**
 * Pure mode resolver. Pack requires a promoted plan with ≥2 stories and
 * non-destructive risk. Destructive stays guided (single writer).
 */
export function resolveMissionOrchestrationMode(
  input: ResolveMissionOrchestrationModeInput,
): MissionOrchestrationMode {
  if (input.forcedMode) return input.forcedMode;
  if ((input.lane ?? "standard") !== "standard") return "livre";
  if (input.risk === "destructive") return "guided";
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
  const storyTasks: WavePackPlannedTask[] = input.stories.map((story, index) => {
    const executor = input.executors[index % input.executors.length]!;
    const plannerId = `wave-pack-${story.id}`.slice(0, 128);
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
        files: Object.freeze([...input.ownershipFiles]),
        symbols: Object.freeze([] as string[]),
        domains: Object.freeze([
          "guided-implementation",
          WAVE_PACK_DOMAIN,
          wavePackStoryDomain(story.id),
          ...coverage,
        ]),
      }),
      dependsOn: Object.freeze([] as string[]),
    });
  });

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
