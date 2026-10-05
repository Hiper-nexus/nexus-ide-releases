import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { recordJevDecision } from '../jev/jev-decision-log';
import { clampUtf8TextPrefix } from '../../shared/utf8-byte-limits';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { runPeriodicTask } from '../observability/periodic-task';
import {
  distillHandoffSummary,
  type DistillHandoffSummaryDeps,
  type MemoryDistillSkipReason,
} from '../jev/jev-memory-distill';
import { missionLinkTarget } from './memory-links';
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


function trustedContent(
  event: TrustedMemoryEvent,
  policy: TrustedMemoryPolicy,
): string {
  const lines = event.title
    ? [`# ${event.title}`, '', `${policy.label}:`]
    : [`${policy.label}:`];
  // Knowledge must survive the byte cap even when the evidence list is large.
  const provenance = event.type === 'accepted-handoff' || event.type === 'session-digest'
    ? '[Agent report, unverified; Jev approved for retention, not factual verification.] ' : '';
  // Keep provenance on the Summary line: the prompt formatter selects that line.
  lines.push(`Summary: ${provenance}${event.summary}`);
  if (event.missionId) lines.push(`Mission: ${event.missionId}`);
  if (event.reference) lines.push(`Reference: ${event.reference}`);
  if (event.evidenceIds?.length) {
    lines.push(`Evidence: ${event.evidenceIds.join(', ')}`);
  }
  return clampUtf8TextPrefix(lines.join('\n'), TRUSTED_CONTENT_MAX_BYTES);
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
    ...(input.distilledSummary ? [input.distilledSummary] : []),
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
  const store = getWorkspaceMemoryStore(scope);
  const source = `trusted:${event.type}`;
  // Evento trusted só substitui linha da própria classe: nunca nota do
  // operador, memória de agente ou outra classe trusted.
  if (options.supersedes && store.activeWorkspaceSource(options.supersedes) !== source) {
    throw new Error(`trusted ${event.type} can only supersede an active ${source} memory`);
  }
  return store.retain({
    content: trustedContent(event, policy),
    kind: policy.kind,
    importance: policy.importance,
    scope: 'workspace',
    source,
    ...(options.supersedes ? { supersedes: options.supersedes } : {}),
  });
}

export function retainAcceptedHandoffMemory(
  scope: ProjectExecutionScope,
  rawInput: AcceptedHandoffMemoryInput,
  options: { supersedes?: string } = {},
): RetainResult | null {
  requireTrustedMemoryEnabled();
  if (!rawInput.distilledSummary) { recordMemoryRetentionSkip(scope, 'empty'); return null; }
  return retainParsedTrustedMemory(
    scope,
    buildAcceptedHandoffTrustedEvent(rawInput),
    options,
  );
}

export function retainAcceptedHandoffMemoryBestEffort(
  scope: ProjectExecutionScope,
  rawInput: AcceptedHandoffMemoryInput,
  options: { supersedes?: string } = {},
): RetainResult | null {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    recordMemoryRetentionSkip(scope, 'flag-off');
    return null;
  }
  try {
    return retainAcceptedHandoffMemory(scope, rawInput, options);
  } catch (error) {
    recordMemoryRetentionSkip(scope, 'store-unavailable');
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

/** Only Jev-approved substance is retained; receipts alone are not knowledge. */
export async function retainAcceptedHandoffMemoryDistilledBestEffort(
  scope: ProjectExecutionScope,
  rawInput: AcceptedHandoffMemoryInput,
  agentSummary: string | null | undefined,
  deps: DistillHandoffSummaryDeps = {},
): Promise<RetainResult | null> {
  try {
    const event = buildAcceptedHandoffTrustedEvent({ ...rawInput, distilledSummary: undefined });
    return await distillMemoryWithRetry(scope, event, agentSummary, deps, { summarySuffix: event.summary });
  } catch {
    recordMemoryRetentionSkip(scope, 'store-unavailable');
    return null;
  }
}

export const acknowledgedHandoffMemoryInputSchema = z
  .object({
    handoffId: trustedIdentifierSchema,
    missionId: trustedIdentifierSchema.optional(),
    status: z.literal('success'),
    mcpReceiptId: trustedIdentifierSchema.optional(),
  })
  .strict();

export type AcknowledgedHandoffMemoryInput = z.infer<
  typeof acknowledgedHandoffMemoryInputSchema
>;

/** Shared path for delivered helpers, mission handoffs and the ACK fallback. */
export async function retainAcknowledgedHandoffMemoryBestEffort(
  scope: ProjectExecutionScope,
  rawInput: AcknowledgedHandoffMemoryInput,
  agentSummary: string | null | undefined,
  deps: DistillHandoffSummaryDeps = {},
): Promise<RetainResult | null> {
  try {
    const input = acknowledgedHandoffMemoryInputSchema.parse(rawInput);
    return await distillMemoryWithRetry(scope, {
      type: 'accepted-handoff',
      title: 'Delivered handoff',
      summary: 'Pending distillation',
      ...(input.missionId ? { missionId: input.missionId } : {}),
      reference: input.handoffId,
    }, agentSummary, deps, { summarySuffix: `Handoff: ${input.handoffId}` });
  } catch {
    recordMemoryRetentionSkip(scope, 'store-unavailable');
    return null;
  }
}

const FINDING_ID_TOKEN_RE = /^F-\d{2,9}$/i;
const QA_ITEM_PATH_TOKEN_RE = /(?:^|\/)docs\/qa\/items\/(F-\d{2,9})\.md$/i;
/** Declaração de correção concluída (não intenção: "corrigir", "fix", "fixing"). */
const FIX_DECLARATION_TOKEN_RE =
  /^(?:corrigid[oa]s?|corrigi(?:u|mos)?|corrige|fixed|fixes|resolvid[oa]s?|resolveu|resolved|resolves|solucionad[oa]s?|reparad[oa]s?|closed|closes)$/i;
/** Negação, ressalva parcial ou item em aberto na cláusula do id desfaz a declaração. */
const NEGATION_TOKEN_RE =
  /^(?:n[aã]o|nem|nunca|jamais|not|never|cannot|\p{L}+n['’]t|unfixed|unresolved|parcial|parcialmente|partial|partially|partly|pendente|pending|reaberto|reopened|abert[oa]s?|open)$/iu;
/** Fronteira de cláusula: pontuação de oração e conjunções adversativas. */
const CLAUSE_SPLIT_RE =
  /[;:,()[\]{}—–]+|\s+(?:mas|porém|porem|contudo|entretanto|todavia|enquanto|but|however|while|whereas|although|though)\s+/iu;
/** Cláusula só de referência ("ver docs/qa/items/F-XXX.md") herda a anterior. */
const REFERENCE_WORD_RE =
  /^(?:ver|veja|vide|see|cf|ref|refs|conforme|item|qa|em|no|na|in|per|detalhes|details|o|a|the)$/i;
/** Herança exige referência explícita: id nu ("F-911:") abre o próprio grupo. */
const REFERENCE_MARKER_RE = /^(?:ver|veja|vide|see|cf|ref|refs|conforme)$/i;
const PERTINENT_EXCERPT_MAX_CHARS = 2_000;

export interface DeclaredQaFix {
  /** Id do item de QA (`F-XXX`) ligado à declaração positiva. */
  readonly id: string;
  /** Trecho pertinente (frase do resumo ou linha do artefato) que vai ao Jev. */
  readonly excerpt: string;
}

function findingIdOfToken(token: string): string | null {
  if (FINDING_ID_TOKEN_RE.test(token)) return token.toUpperCase();
  const pathHit = QA_ITEM_PATH_TOKEN_RE.exec(token);
  return pathHit ? pathHit[1]!.toUpperCase() : null;
}

function clauseTokens(clause: string): string[] {
  return clause
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’]+$/gu, ''))
    .filter(Boolean);
}

/**
 * Agrupa as cláusulas da frase por id: cláusula com id próprio abre um grupo;
 * cláusula sem id (ressalva, complemento) e cláusula só de referência entram
 * no grupo corrente. Um id só vale com verbo de correção concluída no seu
 * grupo e nenhuma negação/ressalva nele — "F-911 continua aberto; F-912 foi
 * corrigido" dá F-912; "corrigido apenas parcialmente" não dá nada.
 */
function declaredFixInSentence(sentence: string): string | null {
  if (/\?\s*$/.test(sentence)) return null; // pergunta não é declaração
  const groups: Array<{ ids: string[]; declared: boolean; negated: boolean }> = [];
  let current: (typeof groups)[number] | null = null;
  for (const clause of sentence.split(CLAUSE_SPLIT_RE)) {
    const tokens = clauseTokens(clause);
    if (tokens.length === 0) continue;
    const ids = tokens.flatMap((token) => findingIdOfToken(token) ?? []);
    const words = tokens.filter((token) => !findingIdOfToken(token));
    const referenceOnly =
      ids.length > 0 &&
      words.some((word) => REFERENCE_MARKER_RE.test(word)) &&
      words.every((word) => REFERENCE_WORD_RE.test(word));
    if (!current || (ids.length > 0 && !referenceOnly)) {
      current = { ids: [], declared: false, negated: false };
      groups.push(current);
    }
    current.ids.push(...ids);
    current.declared ||= words.some((word) => FIX_DECLARATION_TOKEN_RE.test(word));
    current.negated ||= words.some((word) => NEGATION_TOKEN_RE.test(word));
  }
  // Ressalvas do MESMO id se somam na frase; ids diferentes são independentes.
  const verdicts = new Map<string, { declared: boolean; negated: boolean }>();
  for (const group of groups) {
    for (const id of group.ids) {
      const verdict = verdicts.get(id) ?? { declared: false, negated: false };
      verdict.declared ||= group.declared;
      verdict.negated ||= group.negated;
      verdicts.set(id, verdict);
    }
  }
  for (const [id, verdict] of verdicts) {
    if (verdict.declared && !verdict.negated) return id;
  }
  return null;
}

/**
 * Gatilho do escritor de relato de correção: exige declaração POSITIVA na
 * cláusula do id (ou na linha do artefato) — verbo de correção concluída,
 * sem negação, ressalva parcial ou "aberto" no mesmo grupo de cláusulas.
 * Citar o arquivo do item não basta ("Bug ainda aberto; ver
 * docs/qa/items/F-XXX.md"). Puro e determinístico; o trecho devolvido (a
 * frase) é o que o Jev destila.
 */
export function extractResolvedQaFinding(
  texts: ReadonlyArray<string | null | undefined>,
): DeclaredQaFix | null {
  for (const text of texts) {
    if (!text) continue;
    const sentences = text
      .slice(0, 65_536)
      .split(/\r?\n+|(?<=[.!?])\s+/u)
      .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      const id = declaredFixInSentence(sentence);
      if (id) {
        return Object.freeze({
          id,
          excerpt: Array.from(sentence).slice(0, PERTINENT_EXCERPT_MAX_CHARS).join(''),
        });
      }
    }
  }
  return null;
}

const QA_ITEM_MAX_BYTES = 64 * 1024;
const QA_ITEM_FIXED_STATUS_RE = /^(?:corrigido|verificado)\b/i;

/** Status do item de QA no formato do repositório (linha `## F-XXX | … | status:` ou seção `## Status`). */
export function qaItemDeclaresFixedStatus(text: string, findingId: string): boolean {
  if (!FINDING_ID_TOKEN_RE.test(findingId)) return false;
  const head = text.slice(0, 8_192);
  const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
  if (!new RegExp(`^#\\s+${findingId}(?![\\w-])`).test(firstLine)) return false;
  const inline = new RegExp(
    `^##\\s+${findingId}(?![\\w-])[^\\n]*\\|\\s*status:\\s*([^|\\r\\n]+)`,
    'im',
  ).exec(head)?.[1];
  const section = /^##\s+Status\s*\r?\n+\s*([^\r\n]+)/im.exec(head)?.[1];
  const status = (inline ?? section)?.trim();
  return Boolean(status && QA_ITEM_FIXED_STATUS_RE.test(status));
}

/**
 * Confirmação Main-owned do item de QA citado: `docs/qa/items/F-XXX.md` existe
 * DENTRO do workspace do escopo, sem symlink em nenhum componente abaixo da
 * raiz (lstat + O_NOFOLLOW + mesmo inode), até 64 KB, e declara status
 * corrigido/verificado. Assíncrono; qualquer falha é "não confirmado".
 */
export async function confirmQaItemFixedInWorkspace(
  workspaceRoot: string,
  findingId: string,
): Promise<boolean> {
  if (!FINDING_ID_TOKEN_RE.test(findingId) || !path.isAbsolute(workspaceRoot)) {
    return false;
  }
  try {
    let current = workspaceRoot;
    for (const segment of ['docs', 'qa', 'items']) {
      current = path.join(current, segment);
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    const file = path.join(current, `${findingId}.md`);
    const linkStat = await fs.promises.lstat(file);
    if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size > QA_ITEM_MAX_BYTES) {
      return false;
    }
    const handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    let text: string;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.dev !== linkStat.dev ||
        stat.ino !== linkStat.ino ||
        stat.size > QA_ITEM_MAX_BYTES
      ) {
        return false;
      }
      const buffer = Buffer.alloc(QA_ITEM_MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > QA_ITEM_MAX_BYTES) return false;
      text = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
    return qaItemDeclaresFixedStatus(text, findingId);
  } catch {
    return false;
  }
}

/** Título da classe "relato de correção": a chave de assunto é por item de QA. */
export const REPORTED_FIX_TITLE_PREFIX = 'Reported fix ';
const HANDOFF_ORDER_LINE_PREFIX = 'Handoff at: ';
const REPORTED_FIX_MARK =
  'Agent report, unverified; Jev approved for retention, not factual verification.';
const reportedFixQuarantineSchema = z.enum([
  'web-exposed session',
  'read-only session',
  'unproven author session',
]);

const reportedFixHandoffSchema = z
  .object({
    handoffId: trustedIdentifierSchema,
    missionId: trustedIdentifierSchema,
    status: z.literal('success'),
    /** `createdAt` do handoff, gravado pelo Main: a ordem entre relatos. */
    handoffCreatedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
    summary: z.string().max(65_536).optional(),
    artifactsText: z.string().max(16_384).optional(),
    /** F-808: causa da quarentena (derivada pelo Main a partir do autor). */
    quarantine: reportedFixQuarantineSchema.optional(),
    /** F-806: autor readOnly, missão de consulta ou autoridade não provada — veta o vault. */
    readOnlyContext: z.boolean().optional(),
  })
  .strict();

export type ReportedFixHandoffInput = z.infer<typeof reportedFixHandoffSchema>;

/**
 * Autoridade opaca dos relatos de correção de UMA missão, derivada do escopo
 * e da missão (Main) — nunca de texto do agente. Formato da camada de notas
 * de agente, então o filtro do F-808 (mesma missão, quarentena) vale inteiro.
 */
export function reportedFixAuthority(
  scope: ProjectExecutionScope,
  missionId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'nexus-reported-fix', scope.installationId, scope.projectId, scope.checkoutId, missionId,
    ]))
    .digest('hex');
  return `agent-authored:mission:${digest}`;
}

const agentReportSchema = z
  .object({
    source: z.string().regex(/^agent-authored:mission:[a-f0-9]{64}$/),
    findingId: z.string().regex(/^F-\d{2,9}$/),
    handoffId: trustedIdentifierSchema,
    handoffAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
    missionId: trustedIdentifierSchema,
    quarantine: reportedFixQuarantineSchema.nullable(),
    vault: z.boolean(),
  })
  .strict();

type AgentReport = z.infer<typeof agentReportSchema>;

const pendingAgentReportSchema = z
  .object({
    agentReport: agentReportSchema,
    agentSummary: z.string().min(1).max(65_536),
  })
  .strict();

/**
 * Relato de correção de bug declarado por handoff de missão aceito/entregue
 * (F-911). M1/F-808 — relato não é fato: o handoff é `unverified` e o Jev só
 * aprova relevância, nunca a alegação. A linha nasce na camada de notas de
 * agente (`agent-authored:mission:<autoridade da missão>`), marcada "Agent
 * report, unverified", ligada à missão: só workers da MESMA missão a recebem,
 * na seção não verificada; o Main grava em quarentena o relato de sessão
 * exposta à web, de autor readOnly, de missão de consulta ou de autor cuja
 * autoridade não foi provada, e contexto read-only nunca escreve no vault;
 * nunca entra no contexto confiável nem no permanente.
 * `trusted:resolved-problem` com autoridade fica reservado a correção com
 * evidência validada pelo Main — caminho que hoje não existe.
 *
 * Antes do Jev, o Main confirma o item de QA no workspace (status corrigido);
 * ao Jev vai só o trecho pertinente (frase do resumo ou linha do artefato).
 * Replay é idempotente por (handoff, classe) e nunca substitui relato de
 * handoff mais novo ou de mesma hora. Best-effort: nunca segura aceite,
 * entrega ou ACK.
 */
export async function retainReportedFixFromHandoffBestEffort(
  scope: ProjectExecutionScope,
  rawInput: ReportedFixHandoffInput,
  deps: DistillHandoffSummaryDeps = {},
): Promise<RetainResult | null> {
  let input: ReportedFixHandoffInput;
  try {
    input = reportedFixHandoffSchema.parse(rawInput);
  } catch {
    return null;
  }
  const declared = extractResolvedQaFinding([input.summary, input.artifactsText]);
  if (!declared) return null;
  try {
    if (!(await confirmQaItemFixedInWorkspace(scope.rootRealPath, declared.id))) {
      recordMemoryRetentionSkip(scope, 'qa-unconfirmed');
      return null;
    }
    return await distillAgentReportWithRetry(
      scope,
      {
        source: reportedFixAuthority(scope, input.missionId),
        findingId: declared.id,
        handoffId: input.handoffId,
        handoffAt: input.handoffCreatedAt,
        missionId: input.missionId,
        quarantine: input.quarantine ?? null,
        vault: input.readOnlyContext !== true,
      },
      declared.excerpt,
      deps,
    );
  } catch {
    recordMemoryRetentionSkip(scope, 'store-unavailable');
    return null;
  }
}

/**
 * Idempotência durável por (handoff, classe "Reported fix") e ordem
 * Main-owned: qualquer linha já gravada para este handoff — ativa,
 * substituída ou esquecida pelo operador — encerra o replay; e um relato só
 * substitui o relato ativo do mesmo assunto quando o handoff dele é
 * ESTRITAMENTE mais novo (mesma hora não decide ordem: rejeita). Síncrono:
 * roda colado à gravação, sem await no meio.
 */
function reportAllowsWrite(
  store: ReturnType<typeof getWorkspaceMemoryStore>,
  report: AgentReport,
): boolean {
  if (store.workspaceRecordExists(
    report.source, `# ${REPORTED_FIX_TITLE_PREFIX}`, `Handoff: ${report.handoffId}`,
  )) {
    return false;
  }
  const current = store.activeWorkspaceSameSubject(
    report.source, `# ${REPORTED_FIX_TITLE_PREFIX}${report.findingId}`,
  );
  if (!current) return true;
  const stamp = current.content
    .split('\n')
    .find((line) => line.startsWith(HANDOFF_ORDER_LINE_PREFIX))
    ?.slice(HANDOFF_ORDER_LINE_PREFIX.length);
  const currentAt = stamp ? Date.parse(stamp) : Number.NaN;
  return !(Number.isFinite(currentAt) && currentAt >= report.handoffAt);
}

function retainReportedFixNote(
  store: ReturnType<typeof getWorkspaceMemoryStore>,
  report: AgentReport,
  approved: string,
): RetainResult {
  const content = clampUtf8TextPrefix([
    `# ${REPORTED_FIX_TITLE_PREFIX}${report.findingId}`,
    '',
    REPORTED_FIX_MARK,
    `Summary: ${approved}`,
    `Handoff: ${report.handoffId}`,
    `${HANDOFF_ORDER_LINE_PREFIX}${new Date(report.handoffAt).toISOString()}`,
    `Mission: ${report.missionId}`,
    `Reference: docs/qa/items/${report.findingId}.md`,
  ].join('\n'), TRUSTED_CONTENT_MAX_BYTES);
  const mission = missionLinkTarget(report.missionId);
  return store.retainAgentAuthored(
    { content, kind: 'fact', importance: 3, scope: 'workspace' },
    { source: report.source },
    {
      links: mission ? [mission] : [],
      quarantine: report.quarantine,
      // F-806: contexto read-only nunca escreve na pasta do projeto.
      vault: report.vault,
    },
  );
}

/** Categorical diagnostics, never the content or exception text. */
export function recordMemoryRetentionSkip(
  scope: ProjectExecutionScope | null | undefined,
  reason: string,
): void {
  recordJevDecision({ surface: 'memoryDistill', model: 'unavailable', questions: [],
    probabilities: {}, decision: `skip:${reason}`, inputTokens: null, usd: null });
  countMemoryRetentionSkip(scope, reason);
}

function countMemoryRetentionSkip(scope: ProjectExecutionScope | null | undefined, reason: string): void {
  if (!scope) return;
  try { getWorkspaceMemoryStore(scope).recordRetentionSkip(reason); }
  catch { console.warn('[memory] retention diagnostics unavailable:', reason); }
}

const pendingRetentionSchema = z.object({
  event: trustedMemoryEventSchema,
  agentSummary: z.string().min(1).max(3 * 65_536 + 6),
  options: z.object({ supersedes: z.string().max(128).optional(), summarySuffix: z.string().max(16_384).optional() }).strict(),
}).strict();
const retryableSkips = new Set(['no-route', 'timeout', 'jev-off', 'flag-off', 'aborted', 'malformed']);
const retryingStores = new WeakSet<object>();
const pendingWrites = new WeakMap<object, Map<string, Promise<RetainResult | null>>>();

/** Store da retenção (flag, texto e banco ok) e, de carona, a redestilação pendente. */
function openRetentionStore(
  scope: ProjectExecutionScope,
  agentSummary: string | null | undefined,
  deps: DistillHandoffSummaryDeps,
  distillOverride: typeof distillHandoffSummary,
): ReturnType<typeof getWorkspaceMemoryStore> | null {
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)) {
    recordMemoryRetentionSkip(scope, 'flag-off');
    return null;
  }
  if (!agentSummary?.trim()) { recordMemoryRetentionSkip(scope, 'empty'); return null; }
  let store: ReturnType<typeof getWorkspaceMemoryStore>;
  try { store = getWorkspaceMemoryStore(scope); }
  catch { recordMemoryRetentionSkip(scope, 'store-unavailable'); return null; }
  if (!retryingStores.has(store) && store.stats().retention.pending > 0) {
    void retryPendingMemoryRetentions(scope, deps, distillOverride).catch(() => {
      recordMemoryRetentionSkip(scope, 'store-unavailable');
    });
  }
  return store;
}

/**
 * Núcleo durável: enfileira `key` (payload que a redestilação sabe reler),
 * pergunta ao Jev e grava só o aprovado. `allowsWrite` (opcional, síncrono)
 * roda antes do Jev — o replay negado sai da fila — e de novo colado à gravação.
 */
async function distillWithDurableRetry(
  scope: ProjectExecutionScope,
  store: ReturnType<typeof getWorkspaceMemoryStore>,
  key: string,
  agentSummary: string,
  deps: DistillHandoffSummaryDeps,
  distillOverride: typeof distillHandoffSummary,
  write: (approved: string) => RetainResult,
  allowsWrite?: () => boolean,
): Promise<RetainResult | null> {
  if (allowsWrite && !allowsWrite()) {
    store.removePendingRetention(store.enqueueRetention(key));
    recordMemoryRetentionSkip(scope, 'replay');
    return null;
  }
  const pending = pendingWrites.get(store) ?? new Map<string, Promise<RetainResult | null>>();
  if (pending.has(key)) return pending.get(key)!;
  pendingWrites.set(store, pending);
  const attempt = (async () => {
    let reason: string | undefined;
    const onSkip = (skip: MemoryDistillSkipReason) => { reason = skip; countMemoryRetentionSkip(scope, skip); deps.onSkip?.(skip); };
    const queuedId = store.enqueueRetention(key);
    try {
      const approved = await distillOverride({ summary: agentSummary }, { ...deps, onSkip });
      // Cancellation keeps the durable retry payload, but never commits a late provider result.
      if (deps.signal?.aborted) return null;
      if (!approved) {
        if (!reason) { reason = 'jev-skip'; recordMemoryRetentionSkip(scope, reason); deps.onSkip?.('jev-skip'); }
        if (!retryableSkips.has(reason)) store.removePendingRetention(queuedId);
        return null;
      }
      if (allowsWrite && !allowsWrite()) {
        store.removePendingRetention(queuedId);
        recordMemoryRetentionSkip(scope, 'replay');
        return null;
      }
      const result = write(approved);
      store.removePendingRetention(queuedId);
      return result;
    } catch {
      recordMemoryRetentionSkip(scope, 'store-unavailable');
      return null;
    }
  })();
  pending.set(key, attempt);
  try { return await attempt; }
  finally { pending.delete(key); }
}

/** Persist failures in the existing workspace database, then redistill on boot/opportunity. */
export async function distillMemoryWithRetry(
  scope: ProjectExecutionScope,
  event: TrustedMemoryEvent,
  agentSummary: string | null | undefined,
  deps: DistillHandoffSummaryDeps = {},
  options: { supersedes?: string; summarySuffix?: string } = {},
  distillOverride: typeof distillHandoffSummary = distillHandoffSummary,
): Promise<RetainResult | null> {
  const store = openRetentionStore(scope, agentSummary, deps, distillOverride);
  if (!store || !agentSummary) return null;
  const payload = pendingRetentionSchema.parse({ event, agentSummary, options });
  return distillWithDurableRetry(scope, store, JSON.stringify(payload), agentSummary, deps, distillOverride,
    (approved) => {
      const summary = options.summarySuffix ? `${approved}\n${options.summarySuffix}` : approved;
      return retainParsedTrustedMemory(scope, trustedMemoryEventSchema.parse({ ...event, summary }), options);
    });
}

/** Mesma fila durável para o relato de correção (nota de agente, F-911). */
async function distillAgentReportWithRetry(
  scope: ProjectExecutionScope,
  rawReport: AgentReport,
  agentSummary: string,
  deps: DistillHandoffSummaryDeps = {},
  distillOverride: typeof distillHandoffSummary = distillHandoffSummary,
): Promise<RetainResult | null> {
  const store = openRetentionStore(scope, agentSummary, deps, distillOverride);
  if (!store) return null;
  const payload = pendingAgentReportSchema.parse({ agentReport: rawReport, agentSummary });
  const report = payload.agentReport;
  return distillWithDurableRetry(scope, store, JSON.stringify(payload), agentSummary, deps, distillOverride,
    (approved) => retainReportedFixNote(store, report, approved),
    () => reportAllowsWrite(store, report));
}

export async function retryPendingMemoryRetentions(
  scope: ProjectExecutionScope,
  deps: DistillHandoffSummaryDeps = {},
  distillOverride: typeof distillHandoffSummary = distillHandoffSummary,
): Promise<void> {
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)) return;
  const store = getWorkspaceMemoryStore(scope);
  if (retryingStores.has(store)) return;
  retryingStores.add(store);
  try {
    await runPeriodicTask(`memory-retention:${scope.projectId}`, async (ctx) => {
    for (const row of store.pendingRetentions(4)) {
      ctx.assertCurrent();
      let payload: z.infer<typeof pendingRetentionSchema> | z.infer<typeof pendingAgentReportSchema>;
      try {
        const raw: unknown = JSON.parse(row.payload);
        payload = raw && typeof raw === 'object' && 'agentReport' in raw
          ? pendingAgentReportSchema.parse(raw)
          : pendingRetentionSchema.parse(raw);
      } catch { recordMemoryRetentionSkip(scope, 'malformed'); store.removePendingRetention(row.id); continue; }
      let skipped: string | undefined;
      const retryDeps = { ...deps, signal: ctx.signal, onSkip: (reason: MemoryDistillSkipReason) => { skipped = reason; deps.onSkip?.(reason); } };
      let attempt: Promise<RetainResult | null>;
      if ('agentReport' in payload) {
        attempt = distillAgentReportWithRetry(scope, payload.agentReport, payload.agentSummary, retryDeps, distillOverride);
      } else {
        if (payload.options.supersedes && store.activeWorkspaceSource(payload.options.supersedes) !== `trusted:${payload.event.type}`) {
          delete payload.options.supersedes;
        }
        attempt = distillMemoryWithRetry(scope, payload.event, payload.agentSummary, retryDeps, payload.options, distillOverride);
      }
      const result = await ctx.wait(attempt);
      ctx.assertCurrent();
      if (result || (skipped && !retryableSkips.has(skipped))) store.removePendingRetention(row.id);
      if (skipped && retryableSkips.has(skipped)) break; // provider unavailable: avoid hammering the backlog
      await ctx.checkpoint();
    }
    }, { signal: deps.signal, timeoutMs: 30_000, sliceMs: 10 });
  } finally { retryingStores.delete(store); }
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
    recordMemoryRetentionSkip(scope, 'flag-off');
    return null;
  }
  try {
    return retainTrustedMemory(scope, rawEvent, options);
  } catch (error) {
    recordMemoryRetentionSkip(scope, 'store-unavailable');
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
