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
 * Hard ceiling on sealed Pack / NL-fan-out stories (P0-9). Raised from the old
 * 64 so a real decomposition (the field 85-story vibe-code plan) seals in full
 * and the scheduler drains it to exhaustion across refilling waves. This is a
 * runaway backstop, NOT a wave-width cap: wave concurrency stays governed by
 * `maxWorkers`; stories beyond that seal and wait for free slots. A plan that
 * genuinely exceeds this ceiling fails CLOSED with a named error the seal
 * surfaces in mission state — never a silent truncation of the story set.
 */
export const MAX_WAVE_PACK_STORIES = 500;

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
 * A path token: one or more directory segments (so a version like `3.2` or a
 * bare word like `node.js` never qualifies) followed by a `name.ext` file.
 * Accepts `/` and `\` separators and an optional `./` prefix; normalization
 * unifies them afterwards. The extension charset excludes `.` so a trailing
 * sentence period is left outside the match.
 */
const STORY_FILE_PATH_RE = /(?:[\w.-]+[\\/])+[\w.-]+\.[a-z0-9]{1,8}/gi;

/**
 * Producer half of the P0-3 fan-out: read a single story's own file footprint
 * out of its body text. Paths are normalized (`\`→`/`, leading `./` stripped)
 * and de-duplicated, preserving first-mention order. A story that names no path
 * yields `[]` — the caller then keeps the shared-inventory merge-permit path.
 */
export function extractStoryOwnershipFiles(text: string): readonly string[] {
  const matches = String(text ?? "").match(STORY_FILE_PATH_RE);
  if (!matches) return Object.freeze([] as string[]);
  const files: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const file = normalizeWavePackFile(raw);
    if (!file || file.length > 400 || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    if (files.length >= 256) break;
  }
  return Object.freeze(files);
}

/**
 * P0-8 producer: decompose a natural-language guided goal into a disjoint
 * per-file story set so an NL mission fans out onto the same wave-pack
 * machinery as a promoted/Pack plan, instead of collapsing to one whole-repo
 * executor. Each distinct file the goal names becomes one story that owns
 * exactly that file; `extractStoryOwnershipFiles` already de-duplicates in
 * first-mention order, so the emitted partition is pairwise-disjoint by
 * construction. Fewer than 2 named files → `[]` (not decomposable; the caller
 * keeps the single-writer delivery graph).
 */
export function decomposeGuidedGoalIntoStories(input: {
  readonly goal: string;
  readonly acceptanceCriteria?: readonly string[];
}): readonly ExtractedWavePackStory[] {
  const files = extractStoryOwnershipFiles(input.goal);
  if (files.length < 2) return Object.freeze([] as ExtractedWavePackStory[]);
  const capped = files.slice(0, MAX_WAVE_PACK_STORIES);
  const goalExcerpt = input.goal.trim().slice(0, 2_000);
  return Object.freeze(
    capped.map((file, index) =>
      Object.freeze({
        id: `story-nl-${index + 1}`,
        epicStoryId: `1.${index + 1}`,
        title: file.slice(0, 256),
        body: [
          `Implemente a parte da entrega correspondente a ${file}.`,
          `Toque somente ${file} — nada é compartilhado com as outras partes.`,
          "Não implemente outros arquivos. Entregue handoff com o que validou.",
          "",
          "Objetivo da missão:",
          goalExcerpt,
        ]
          .join("\n")
          .slice(0, 8_192),
        ownershipFiles: [file],
      }),
    ),
  );
}

/**
 * P-b produtor: decompõe um objetivo em UMA story por ÁREA do repositório.
 *
 * Complementa `decomposeGuidedGoalIntoStories`, que só abre quando o goal
 * NOMEIA ≥2 arquivos — o caso raro. O caso do dia a dia é trabalho livre num
 * repo existente ("continua codando o sistema"), e ali quem conhece as frentes
 * é o REPOSITÓRIO, não o texto do pedido. As áreas vêm de
 * `partitionOwnershipIntoAreas` sobre o inventário vivo que o planner já lê.
 *
 * Conservador: menos de 2 áreas devolve `[]` — objetivo que toca uma frente
 * NÃO vira leque fingido, e o caminho single-writer segue com o veredito de
 * fase sequencial dizendo o porquê. Disjunção é por construção: cada story
 * recebe exatamente a fatia da sua área, e as áreas já são disjuntas.
 */
export function decomposeGoalByRepositoryAreas(input: {
  readonly goal: string;
  readonly areas: readonly {
    readonly id: string;
    readonly files: readonly string[];
  }[];
}): readonly ExtractedWavePackStory[] {
  // O objetivo tem de TOCAR a área — ter áreas no repo não é razão para abrir
  // leque. Sem esta prova, qualquer goal genérico num monorepo viraria fan-out
  // do repositório inteiro (pego pela regressão: greenfield e inventário
  // quebraram na primeira versão). Casamento por menção explícita: o nome da
  // área, ou seu último segmento, aparece no texto do objetivo.
  const haystack = input.goal.toLocaleLowerCase('en-US');
  const mentions = (areaId: string): boolean => {
    const id = areaId.toLocaleLowerCase('en-US');
    if (haystack.includes(id)) return true;
    const leaf = id.split('/').pop() ?? id;
    return leaf.length >= 3 && new RegExp(`\\b${leaf}\\b`).test(haystack);
  };
  const usable = input.areas.filter(
    (area) => area.files.length > 0 && mentions(area.id),
  );
  if (usable.length < 2) return Object.freeze([] as ExtractedWavePackStory[]);
  const capped = usable.slice(0, MAX_WAVE_PACK_STORIES);
  const goalExcerpt = input.goal.trim().slice(0, 2_000);
  return Object.freeze(
    capped.map((area, index) =>
      Object.freeze({
        id: `story-area-${index + 1}`,
        epicStoryId: `1.${index + 1}`,
        title: area.id.slice(0, 256),
        body: [
          `Implemente a parte da entrega que vive em ${area.id}.`,
          `Toque somente ${area.id} — as outras frentes têm dono próprio.`,
          "Não implemente outras áreas. Entregue handoff com o que validou.",
          "",
          "Objetivo da missão:",
          goalExcerpt,
        ]
          .join("\n")
          .slice(0, 8_192),
        ownershipFiles: [...area.files],
      }),
    ),
  );
}

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
  // First-owner-wins across stories guarantees the emitted partition is
  // pairwise-disjoint by construction: a file named by two stories is owned by
  // the first that declared it, so the fan-out never puts two writers on it.
  const claimedFiles = new Set<string>();
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const epic = match[2]!;
    const story = match[3]!;
    const title = match[4]!.trim().slice(0, 256);
    const start = (match.index ?? 0) + match[0]!.length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    const body = text.slice(start, end).trim().slice(0, 8_192);
    const epicStoryId = `${epic}.${story}`;
    const ownershipFiles = extractStoryOwnershipFiles(body).filter((file) => {
      if (claimedFiles.has(file)) return false;
      claimedFiles.add(file);
      return true;
    });
    stories.push(
      Object.freeze({
        id: `story-${epic}-${story}`,
        epicStoryId,
        title: title || `Story ${epicStoryId}`,
        body,
        // Omit the key entirely when empty so schema/consumer see "no per-story
        // footprint" and keep the shared-inventory merge-permit path.
        ...(ownershipFiles.length > 0 ? { ownershipFiles } : {}),
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

/** One concurrently-active dispatch as the disjointness guard sees it. */
export interface ConcurrentIsolatedWorktreeTask {
  readonly taskId: string;
  readonly executionMode: string;
  readonly ownership: { readonly files: readonly string[] };
}

/**
 * Admit multiple simultaneous `isolated_worktree` writers as valid exactly when
 * their file ownership is pairwise-disjoint. This is the store-side seam for
 * real fan-out: two parallel worktrees may run only if no file is claimed by
 * both, so their serial merges never conflict. Read-only peers hold no writer
 * surface and are ignored. Fail-closed on any shared file.
 *
 * The caller decides WHICH writers to feed it: at dispatch claim time only the
 * disjoint-marked (`wave-pack-disjoint-files`) writers are passed, because a
 * shared-inventory wave-pack writer's file set is a merge permit, not an
 * exclusive claim, and overlapping there is by design.
 */
export function assertConcurrentIsolatedWorktreeDisjoint(
  active: readonly ConcurrentIsolatedWorktreeTask[],
): void {
  const writers = active.filter(
    (task) => task.executionMode === "isolated_worktree",
  );
  const owners = new Map<string, string>();
  for (const writer of writers) {
    for (const raw of writer.ownership.files) {
      const file = normalizeWavePackFile(raw);
      const previous = owners.get(file);
      if (previous !== undefined && previous !== writer.taskId) {
        throw new Error(
          `concurrent_isolated_worktree_files_overlap: ${previous} e ` +
            `${writer.taskId} disputam ${file} — writers simultâneos exigem ` +
            "ownership disjunto",
        );
      }
      owners.set(file, writer.taskId);
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
  // P0-9: the seal must not throttle a real decomposition. The old ceiling of
  // 64 rejected an 85-story plan before it could seal, so the mission blocked
  // with story 1.1 as the only unit. The cap is now MAX_WAVE_PACK_STORIES (a
  // runaway backstop, NOT a wave-width cap): all stories seal and the scheduler
  // drains them to exhaustion across refilling waves, bounded per-wave by
  // maxWorkers. Only a plan past the backstop fails — and it fails CLOSED with a
  // named error the seal surfaces in mission state, never a silent truncation.
  if (input.stories.length > MAX_WAVE_PACK_STORIES) {
    throw new Error(
      `wave_pack_too_many_stories: o Pack suporta no máximo ${MAX_WAVE_PACK_STORIES} ` +
        `stories seladas (recebeu ${input.stories.length})`,
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
