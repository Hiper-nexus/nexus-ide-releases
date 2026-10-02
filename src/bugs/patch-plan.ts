import { HTTPException } from 'hono/http-exception';
import type { BugReportRow } from '../db/schema.js';
import type { BugEventKind, BugStatus } from './constants.js';
import { canTransition, eventKindForTransition } from './transitions.js';
import type { PatchReportInput } from './schemas.js';

/** O que o PATCH pode mudar na linha. Lista fixa: nenhum nome de coluna vem do cliente. */
export const UPDATABLE_COLUMNS = ['status', 'severity', 'duplicate_of', 'fix_summary', 'fix_pr_url'] as const;
export type UpdatableColumn = typeof UPDATABLE_COLUMNS[number];

export interface PlannedEvent { readonly kind: BugEventKind; readonly details: Readonly<Record<string, unknown>> }
export interface PatchPlan {
  readonly columns: Readonly<Partial<Record<UpdatableColumn, string | null>>>;
  readonly events: readonly PlannedEvent[];
}

export type PatchTarget = Pick<BugReportRow, 'id' | 'status' | 'severity' | 'duplicate_of' | 'fix_summary' | 'fix_pr_url'>;
/** O relato escolhido como original (nulo = não existe). Só é consultado quando o corpo traz duplicateOf. */
export type DuplicateTarget = Pick<BugReportRow, 'id' | 'status'> | null;

/** Estados cujo evento carrega uma foto da correção: o que foi proposto, aprovado ou liberado. */
const FIX_SNAPSHOT_KINDS: ReadonlySet<BugEventKind> = new Set(['fix_proposed', 'approved', 'released']);

function assertTransition(from: BugStatus, to: BugStatus): void {
  if (from === to) throw new HTTPException(409, { message: `O relato já está em "${to}".` });
  if (!canTransition(from, to)) throw new HTTPException(409, { message: `Transição não permitida: de "${from}" para "${to}".` });
}

/** O valor final de duplicate_of: exigido (e validado) com status duplicate, sempre nulo fora dele. */
function resolveDuplicateOf(current: PatchTarget, patch: PatchReportInput, nextStatus: BugStatus, target: DuplicateTarget): string | null {
  if (nextStatus !== 'duplicate') {
    if (patch.duplicateOf !== undefined) throw new HTTPException(400, { message: 'duplicateOf só vale junto do status "duplicate".' });
    return null;
  }
  const original = patch.duplicateOf ?? current.duplicate_of;
  if (original === null) throw new HTTPException(400, { message: 'Informe duplicateOf: o relato original.' });
  if (patch.duplicateOf !== undefined) {
    if (patch.duplicateOf === current.id) throw new HTTPException(400, { message: 'Um relato não pode ser duplicata dele mesmo.' });
    if (target === null) throw new HTTPException(404, { message: 'Relato original não encontrado.' });
    if (target.status === 'duplicate') throw new HTTPException(409, { message: 'O relato escolhido já é duplicata de outro. Aponte para o original.' });
  }
  return original;
}

function statusEvent(current: PatchTarget, to: BugStatus, duplicateOf: string | null, fix: { summary: string | null; url: string | null }): PlannedEvent {
  const kind = eventKindForTransition(current.status, to);
  return {
    kind,
    details: {
      from: current.status, to,
      ...(to === 'duplicate' ? { duplicateOf } : {}),
      ...(FIX_SNAPSHOT_KINDS.has(kind) ? { fixSummary: fix.summary, fixPrUrl: fix.url } : {}),
    },
  };
}

/**
 * Decide, sem tocar no banco, o que um PATCH muda e que eventos deixa na linha do tempo. Lança 400/404/409
 * (HTTPException) para o que não pode ser feito. Função pura: o estado atual entra por parâmetro.
 */
export function planPatch(current: PatchTarget, patch: PatchReportInput, duplicateTarget: DuplicateTarget): PatchPlan {
  const nextStatus = patch.status ?? current.status;
  if (patch.status !== undefined) assertTransition(current.status, patch.status);
  const duplicateOf = resolveDuplicateOf(current, patch, nextStatus, duplicateTarget);

  const fix = { summary: patch.fixSummary ?? current.fix_summary, url: patch.fixPrUrl ?? current.fix_pr_url };
  const columns: Partial<Record<UpdatableColumn, string | null>> = {};
  const events: PlannedEvent[] = [];

  if (patch.status !== undefined) {
    columns.status = patch.status;
    events.push(statusEvent(current, patch.status, duplicateOf, fix));
  }
  if (duplicateOf !== current.duplicate_of) {
    columns.duplicate_of = duplicateOf;
    if (patch.status === undefined) events.push({ kind: 'duplicate_marked', details: { from: current.status, to: current.status, duplicateOf } });
  }
  if (patch.severity !== undefined && patch.severity !== current.severity) {
    columns.severity = patch.severity;
    events.push({ kind: 'severity_changed', details: { from: current.severity, to: patch.severity } });
  }
  if (patch.note !== undefined) events.push({ kind: 'note', details: { note: patch.note } });

  const fixFields: string[] = [];
  if (patch.fixSummary !== undefined && patch.fixSummary !== current.fix_summary) { columns.fix_summary = patch.fixSummary; fixFields.push('fixSummary'); }
  if (patch.fixPrUrl !== undefined && patch.fixPrUrl !== current.fix_pr_url) { columns.fix_pr_url = patch.fixPrUrl; fixFields.push('fixPrUrl'); }
  if (fixFields.length > 0) events.push({ kind: 'note', details: { updated: fixFields } });

  if (events.length === 0 && Object.keys(columns).length === 0) throw new HTTPException(409, { message: 'Nada mudou: o relato já está assim.' });
  return { columns, events };
}
