/**
 * Mission-scoped context compaction — stable schema for packing prompts
 * without dumping full playbooks or transcript history.
 *
 * Inspired by production agent runtimes: preserve goal/constraints/progress
 * and omit bulk tool output. Pure domain, no I/O.
 */

import { z } from 'zod';
import type { Handoff, Mission } from './orch-types';

export const missionCompactSchema = z.object({
  version: z.literal(1),
  missionId: z.string().min(1).max(128),
  goal: z.string().max(16_384),
  constraints: z.array(z.string().max(2_048)).max(32),
  completed: z.array(z.string().max(2_048)).max(64),
  inProgress: z.array(z.string().max(2_048)).max(32),
  blocked: z.array(z.string().max(2_048)).max(32),
  learnings: z.array(z.string().max(2_048)).max(32),
  decisions: z.array(z.string().max(2_048)).max(32),
  nextSteps: z.array(z.string().max(2_048)).max(32),
  files: z.array(z.string().max(4_096)).max(64),
  omittedNote: z.string().max(512).optional(),
  charCount: z.number().int().nonnegative(),
});

export type MissionCompact = z.infer<typeof missionCompactSchema>;

const DEFAULT_MAX_CHARS = 3_500;

function clipList(items: readonly string[], max: number): string[] {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function collectFilesFromHandoffs(handoffs: readonly Handoff[]): string[] {
  const files: string[] = [];
  for (const handoff of handoffs) {
    for (const art of handoff.artifacts ?? []) {
      if (typeof art === 'string') {
        files.push(art);
        continue;
      }
      if (art && typeof art === 'object' && 'path' in art) {
        const path = (art as { path?: unknown }).path;
        if (typeof path === 'string' && path.trim()) files.push(path.trim());
      }
    }
  }
  return [...new Set(files)].slice(0, 64);
}

/**
 * Build a compact mission memory block from durable state.
 * Truncates lists when the rendered form would exceed maxChars.
 */
export function compactMissionContext(input: {
  readonly mission: Pick<
    Mission,
    'id' | 'description' | 'intentContract' | 'learnings' | 'milestones' | 'status'
  >;
  readonly handoffs?: readonly Handoff[];
  readonly maxChars?: number;
}): MissionCompact {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError('maxChars must be a positive safe integer');
  }
  const goal =
    input.mission.intentContract?.goal?.trim() ||
    input.mission.description.trim() ||
    '(sem objetivo)';
  const constraints = clipList(
    input.mission.intentContract?.acceptanceCriteria ?? [],
    16,
  );
  const completed = clipList(
    input.mission.milestones
      .filter((step) => step.status === 'done')
      .map((step) => step.label),
    24,
  );
  const inProgress = clipList(
    input.mission.milestones
      .filter((step) => step.status === 'in-progress')
      .map((step) => step.label),
    12,
  );
  const blocked = clipList(
    input.mission.milestones
      .filter((step) => step.status === 'blocked')
      .map((step) => step.label),
    12,
  );
  const learnings = clipList(
    input.mission.learnings.split(/\n{2,}|\n(?=##\s)/),
    16,
  );
  const handoffs = input.handoffs ?? [];
  const decisions = clipList(
    handoffs
      .filter((h) => h.status === 'success' || h.status === 'partial')
      .map((h) => h.summary.slice(0, 240)),
    12,
  );
  const nextSteps = clipList(
    handoffs
      .filter((h) => h.status === 'blocked' || h.status === 'stalled' || h.status === 'progress')
      .map((h) => h.summary.slice(0, 240)),
    12,
  );
  const files = collectFilesFromHandoffs(handoffs);

  let compact: MissionCompact = missionCompactSchema.parse({
    version: 1,
    missionId: input.mission.id,
    goal: goal.slice(0, 16_384),
    constraints,
    completed,
    inProgress,
    blocked,
    learnings,
    decisions,
    nextSteps,
    files,
    charCount: 0,
  });

  let rendered = renderMissionCompact(compact);
  if (rendered.length <= maxChars) {
    return { ...compact, charCount: rendered.length };
  }

  // Progressive omission of bulk arrays.
  for (const key of [
    'decisions',
    'nextSteps',
    'completed',
    'files',
    'learnings',
  ] as const) {
    compact = {
      ...compact,
      [key]: compact[key].slice(0, Math.max(2, Math.floor(compact[key].length / 2))),
      omittedNote: 'contexto compactado — detalhes omitidos por orçamento',
    };
    rendered = renderMissionCompact(compact);
    if (rendered.length <= maxChars) {
      return { ...compact, charCount: rendered.length };
    }
  }

  compact = {
    ...compact,
    goal: compact.goal.slice(0, Math.max(80, maxChars - 200)),
    constraints: compact.constraints.slice(0, 3),
    completed: compact.completed.slice(0, 3),
    inProgress: compact.inProgress.slice(0, 2),
    blocked: compact.blocked.slice(0, 2),
    learnings: compact.learnings.slice(0, 3),
    decisions: [],
    nextSteps: compact.nextSteps.slice(0, 2),
    files: compact.files.slice(0, 4),
    omittedNote: 'contexto fortemente compactado — use tools para recuperar detalhes',
  };
  rendered = renderMissionCompact(compact);
  if (rendered.length <= maxChars) {
    return { ...compact, charCount: rendered.length };
  }

  // Individual entries can each be large. Drop lower-priority sections before
  // clipping the goal so the returned block obeys the caller's hard budget.
  for (const key of [
    'decisions',
    'nextSteps',
    'completed',
    'files',
    'learnings',
    'constraints',
    'inProgress',
    'blocked',
  ] as const) {
    if (compact[key].length === 0) continue;
    compact = { ...compact, [key]: [] };
    rendered = renderMissionCompact(compact);
    if (rendered.length <= maxChars) {
      return { ...compact, charCount: rendered.length };
    }
  }

  const clipGoalToBudget = (): void => {
    const overflow = rendered.length - maxChars;
    if (overflow <= 0) return;
    compact = {
      ...compact,
      goal: compact.goal.slice(0, Math.max(0, compact.goal.length - overflow)),
    };
    rendered = renderMissionCompact(compact);
  };
  clipGoalToBudget();
  if (rendered.length > maxChars && compact.omittedNote) {
    compact = { ...compact, omittedNote: undefined };
    rendered = renderMissionCompact(compact);
    clipGoalToBudget();
  }
  if (rendered.length > maxChars) {
    throw new RangeError('maxChars is too small for the compact mission envelope');
  }
  return { ...compact, charCount: rendered.length };
}

/**
 * True when the compact carries memory beyond goal/criteria (progress,
 * learnings, decisions, files). A freshly dispatched mission has none — its
 * goal and criteria already live in the kickoff, so rendering the compact
 * there would only duplicate them.
 */
export function missionCompactHasProgress(compact: MissionCompact): boolean {
  return (
    compact.completed.length > 0 ||
    compact.inProgress.length > 0 ||
    compact.blocked.length > 0 ||
    compact.learnings.length > 0 ||
    compact.decisions.length > 0 ||
    compact.nextSteps.length > 0 ||
    compact.files.length > 0
  );
}

/** Markdown packing for prompts (layers: invariants stay elsewhere). */
export function renderMissionCompact(compact: MissionCompact): string {
  const lines: string[] = [
    `## Memória compacta da missão (${compact.missionId})`,
    `**Objetivo:** ${compact.goal}`,
  ];
  if (compact.constraints.length) {
    lines.push('**Critérios:**', ...compact.constraints.map((c) => `- ${c}`));
  }
  if (compact.completed.length) {
    lines.push('**Concluído:**', ...compact.completed.map((c) => `- ${c}`));
  }
  if (compact.inProgress.length) {
    lines.push('**Em andamento:**', ...compact.inProgress.map((c) => `- ${c}`));
  }
  if (compact.blocked.length) {
    lines.push('**Bloqueado:**', ...compact.blocked.map((c) => `- ${c}`));
  }
  if (compact.learnings.length) {
    lines.push(
      '**Aprendizados duráveis:**',
      ...compact.learnings.map((learning) => `- ${learning}`),
    );
  }
  if (compact.decisions.length) {
    lines.push('**Decisões/resultados:**', ...compact.decisions.map((c) => `- ${c}`));
  }
  if (compact.nextSteps.length) {
    lines.push('**Próximos passos:**', ...compact.nextSteps.map((c) => `- ${c}`));
  }
  if (compact.files.length) {
    lines.push('**Arquivos:**', ...compact.files.map((f) => `- ${f}`));
  }
  if (compact.omittedNote) {
    lines.push(`_${compact.omittedNote}_`);
  }
  return lines.join('\n');
}
