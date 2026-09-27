import { z } from 'zod';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  distillHandoffSummary,
  type DistillHandoffSummaryDeps,
} from '../jev/jev-memory-distill';
import {
  getWorkspaceMemoryStore,
  type MemoryKind,
  type RetainResult,
} from './workspace-memory';

export const TRUSTED_MEMORY_EVENT_TYPES = [
  'operator-decision',
  'accepted-handoff',
  'resolved-problem',
  'architecture-rule',
  'approved-merge',
  'session-digest',
  'operator-preference',
] as const;

export const trustedMemoryEventSchema = z
  .object({
    type: z.enum(TRUSTED_MEMORY_EVENT_TYPES),
    title: z.string().trim().min(1).max(256).optional(),
    summary: z.string().trim().min(1).max(65_536),
    missionId: z.string().min(1).max(128).optional(),
    reference: z.string().min(1).max(2_048).optional(),
    evidenceIds: z
      .array(z.string().min(1).max(256))
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'evidenceIds must be unique',
      })
      .optional(),
  })
  .strict();

export type TrustedMemoryEvent = z.infer<typeof trustedMemoryEventSchema>;

const trustedIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const trustedSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const trustedCommitSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const acceptedHandoffMemoryInputSchema = z
  .object({
    handoffId: trustedIdentifierSchema,
    missionId: trustedIdentifierSchema,
    taskId: trustedIdentifierSchema,
    dispatchId: trustedIdentifierSchema,
    status: z.literal('success'),
    acceptedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
    /**
     * Resumo destilado do handoff (texto do agente, Main-validado pelo aceite).
     * Só entra quando o Jev (superfície memoryDistill) aprova; colapsado em
     * uma linha e limitado a 400 caracteres.
     */
    distilledSummary: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .transform((value) => value.replace(/\s+/g, ' ').trim())
      .refine((value) => value.length > 0)
      .optional(),
    evidenceIds: z
      .array(trustedIdentifierSchema)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'evidenceIds must be unique',
      })
      .optional(),
    evidenceBinding: z
      .object({
        missionId: trustedIdentifierSchema,
        contextRevision: trustedSha256Schema,
        contractHash: trustedSha256Schema,
        baseSha: trustedCommitSchema,
        headSha: trustedCommitSchema,
        diffHash: trustedSha256Schema,
        workflowRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    mcpReceiptId: trustedIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.evidenceBinding &&
      input.evidenceBinding.missionId !== input.missionId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceBinding', 'missionId'],
        message: 'evidence binding belongs to another mission',
      });
    }
    if (input.evidenceIds?.length && !input.evidenceBinding) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceIds'],
        message: 'trusted evidence ids require a verified evidence binding',
      });
    }
  });

export type AcceptedHandoffMemoryInput = z.infer<
  typeof acceptedHandoffMemoryInputSchema
>;

interface TrustedMemoryPolicy {
  readonly label: string;
  readonly kind: MemoryKind;
  readonly importance: number;
}

const TRUSTED_MEMORY_POLICY: Readonly<
  Record<TrustedMemoryEvent['type'], TrustedMemoryPolicy>
> = {
  'operator-decision': {
    label: 'Operator decision',
    kind: 'decision',
    importance: 5,
  },
  'accepted-handoff': {
    label: 'Accepted handoff',
    kind: 'fact',
    importance: 4,
  },
  'resolved-problem': {
    label: 'Resolved problem',
    kind: 'fact',
    importance: 5,
  },
  'architecture-rule': {
    label: 'Architecture rule',
    kind: 'decision',
    importance: 5,
  },
  'approved-merge': {
    label: 'Approved merge',
    kind: 'fact',
    importance: 5,
  },
  'session-digest': {
    label: 'Session digest',
    kind: 'fact',
    importance: 3,
  },
  'operator-preference': {
    label: 'Operator preference',
    kind: 'preference',
    importance: 4,
  },
};

const TRUSTED_CONTENT_MAX_BYTES = 7_800;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function trustedContent(
  event: TrustedMemoryEvent,
  policy: TrustedMemoryPolicy,
): string {
  const lines = event.title
    ? [`# ${event.title}`, '', `${policy.label}:`]
    : [`${policy.label}:`];
  if (event.missionId) lines.push(`Mission: ${event.missionId}`);
  if (event.reference) lines.push(`Reference: ${event.reference}`);
  if (event.evidenceIds?.length) {
    lines.push(`Evidence: ${event.evidenceIds.join(', ')}`);
  }
  lines.push(`Summary: ${event.summary}`);
  return truncateUtf8(lines.join('\n'), TRUSTED_CONTENT_MAX_BYTES);
}

/**
 * Converts a physically accepted handoff into a closed Main-owned projection.
 * The only free text is `distilledSummary`: agent text that the Jev
 * memoryDistill surface approved, sanitized to one line of at most 400 chars.
 */
export function buildAcceptedHandoffTrustedEvent(
  rawInput: AcceptedHandoffMemoryInput,
): TrustedMemoryEvent {
  const input = acceptedHandoffMemoryInputSchema.parse(rawInput);
  const lines = [
    'Handoff accepted by Nexus Main.',
    `Handoff: ${input.handoffId}`,
    `Mission: ${input.missionId}`,
    `Task: ${input.taskId}`,
    `Dispatch: ${input.dispatchId}`,
    'Status: accepted',
    `Accepted at: ${new Date(input.acceptedAt).toISOString()}`,
  ];
  if (input.mcpReceiptId) {
    lines.push(`MCP receipt: ${input.mcpReceiptId}`);
  }
  if (input.evidenceBinding) {
    lines.push(
      `Context revision: ${input.evidenceBinding.contextRevision}`,
      `Contract: ${input.evidenceBinding.contractHash}`,
      `Base: ${input.evidenceBinding.baseSha}`,
      `Head: ${input.evidenceBinding.headSha}`,
      `Diff: ${input.evidenceBinding.diffHash}`,
      `Workflow revision: ${input.evidenceBinding.workflowRevision}`,
    );
  }
  if (input.distilledSummary) {
    lines.push(`Summary: ${input.distilledSummary}`);
  }
  return trustedMemoryEventSchema.parse({
    type: 'accepted-handoff',
    title: 'Accepted task handoff',
    summary: lines.join('\n'),
    missionId: input.missionId,
    reference: input.handoffId,
    ...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
  });
}

function requireTrustedMemoryEnabled(): void {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    throw new Error('feature.memory.workspaceMemory is disabled');
  }
}

/**
 * The only automatic-retention port. Callers cannot choose kind, importance,
 * source, or global scope; those are fixed by this closed trusted-event map.
 */
export function retainTrustedMemory(
  scope: ProjectExecutionScope,
  rawEvent: TrustedMemoryEvent,
  options: { supersedes?: string } = {},
): RetainResult {
  requireTrustedMemoryEnabled();
  const event = trustedMemoryEventSchema.parse(rawEvent);
  if (event.type === 'accepted-handoff') {
    throw new Error(
      'accepted-handoff memory requires the canonical Main-owned projection',
    );
  }
  return retainParsedTrustedMemory(scope, event, options);
}

function retainParsedTrustedMemory(
  scope: ProjectExecutionScope,
  event: TrustedMemoryEvent,
  options: { supersedes?: string } = {},
): RetainResult {
  const policy = TRUSTED_MEMORY_POLICY[event.type];
  return getWorkspaceMemoryStore(scope).retain({
    content: trustedContent(event, policy),
    kind: policy.kind,
    importance: policy.importance,
    scope: 'workspace',
    source: `trusted:${event.type}`,
    ...(options.supersedes ? { supersedes: options.supersedes } : {}),
  });
}

export function retainAcceptedHandoffMemory(
  scope: ProjectExecutionScope,
  rawInput: AcceptedHandoffMemoryInput,
): RetainResult {
  requireTrustedMemoryEnabled();
  return retainParsedTrustedMemory(
    scope,
    buildAcceptedHandoffTrustedEvent(rawInput),
  );
}

export function retainAcceptedHandoffMemoryBestEffort(
  scope: ProjectExecutionScope,
  rawInput: AcceptedHandoffMemoryInput,
): RetainResult | null {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    return null;
  }
  try {
    return retainAcceptedHandoffMemory(scope, rawInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('requires configureWorkspaceMemory')) {
      console.warn(
        '[memory] trusted accepted-handoff retention unavailable:',
        message,
      );
    }
    return null;
  }
}

/**
 * Retenção do handoff aceito com destilação do resumo: pergunta ao Jev
 * (superfície memoryDistill) se o resumo do agente vale memória e, se sim,
 * grava a linha trusted já com o `Summary:` destilado. Fail-open total —
 * Jev fora do ar mantém a linha de identificadores de hoje. Nunca lança.
 */
export async function retainAcceptedHandoffMemoryDistilledBestEffort(
  scope: ProjectExecutionScope,
  rawInput: AcceptedHandoffMemoryInput,
  agentSummary: string | null | undefined,
  deps: DistillHandoffSummaryDeps = {},
): Promise<RetainResult | null> {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    return null;
  }
  let input = rawInput;
  if (agentSummary && agentSummary.trim()) {
    try {
      const distilled = await distillHandoffSummary(
        { summary: agentSummary },
        deps,
      );
      if (distilled) input = { ...rawInput, distilledSummary: distilled };
    } catch {
      // fail-open: sem destilação, a linha nasce só com identificadores.
    }
  }
  return retainAcceptedHandoffMemoryBestEffort(scope, input);
}

/**
 * Trusted retention is derived bookkeeping. Disk/native-module failure must
 * never roll back a handoff or keep an agent mission waiting.
 */
export function retainTrustedMemoryBestEffort(
  scope: ProjectExecutionScope,
  rawEvent: TrustedMemoryEvent,
  options: { supersedes?: string } = {},
): RetainResult | null {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    return null;
  }
  try {
    return retainTrustedMemory(scope, rawEvent, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('requires configureWorkspaceMemory')) {
      console.warn(
        `[memory] trusted ${rawEvent.type} retention unavailable:`,
        message,
      );
    }
    return null;
  }
}
