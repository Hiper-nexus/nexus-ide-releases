/**
 * Nexus Redline (Linux) — saída para a barra do desktop (módulo `command`).
 *
 * Por que existe: o ícone de bandeja do Redline é um StatusNotifierItem, e o
 * Omarchy (quickshell) guarda os ícones numa gaveta atrás de uma setinha `<`.
 * Quem não abre a gaveta nunca vê o Redline. A barra do Omarchy aceita módulos
 * `command` cuja saída é o JSON do Waybar (`text`, `tooltip`, `class`,
 * `percentage`), e o Waybar aceita o mesmo JSON num módulo `custom`. Este
 * arquivo transforma o snapshot validado nesse JSON.
 *
 * Puro de propósito (sem electron, sem fs, relógio por parâmetro): toda regra
 * vem de `redline-tray-model.ts` (60%/85%, barra de 5 blocos, pior janela da
 * faixa, desconhecido é "—" e NUNCA 0%). Só entram na saída números, palavras
 * fixas e o texto que a camada de parse já saneou e mascarou (e-mail mascarado,
 * sem controle nem bidi); o JSON é montado por `JSON.stringify`.
 */

import type { RedlineSnapshotFile } from '../../shared/redline-types';
import {
  barsText,
  buildRedlineTrayModel,
  entriesForBar,
  pctText,
  worstBarWindow,
  type RedlineMenuItem,
} from './redline-tray-model';

export interface RedlineBarOutput {
  /** Texto curto da barra: `▮▮▮▮▯ 87%`. */
  text: string;
  /** Várias linhas: pior janela e cada conta da faixa. */
  tooltip: string;
  /**
   * `nexus-redline`, a urgência (`ok|warn|danger|unknown`), `stale` quando o
   * dado passou de 10 min e `active` (a barra do Omarchy destaca o módulo)
   * quando a pior janela pede atenção.
   */
  class: string[];
  /** Percentual inteiro da pior janela; AUSENTE quando não há leitura. */
  percentage?: number;
}

export const REDLINE_BAR_CLASS = 'nexus-redline';
const TOOLTIP_MAX_LINES = 40;
const TOOLTIP_MAX_CHARS = 2000;
const CLICK_HINT = 'Clique para abrir as cotas no Nexus';

function tooltipLines(items: readonly RedlineMenuItem[]): string[] {
  const lines: string[] = [];
  let pendingBreak = false;
  for (const item of items) {
    if (item.kind === 'separator') {
      pendingBreak = lines.length > 0;
      continue;
    }
    if (item.kind === 'action') continue;
    if (pendingBreak) {
      lines.push('');
      pendingBreak = false;
    }
    if (item.kind === 'info') {
      lines.push(item.text);
    } else {
      lines.push(item.text);
      lines.push(...tooltipLines(item.items).map((line) => (line === '' ? line : `  ${line}`)));
    }
  }
  return lines;
}

function clipTooltip(lines: readonly string[]): string {
  const kept = lines.slice(0, TOOLTIP_MAX_LINES);
  let text = kept.join('\n');
  if (lines.length > kept.length) text += '\n…';
  if (text.length > TOOLTIP_MAX_CHARS) text = `${text.slice(0, TOOLTIP_MAX_CHARS - 1)}…`;
  return text;
}

/** Snapshot (ou `null`) + relógio → o JSON que a barra desenha. */
export function buildRedlineBarOutput(
  snapshot: RedlineSnapshotFile | null,
  nowMs: number,
): RedlineBarOutput {
  const model = buildRedlineTrayModel(snapshot, nowMs);
  const classes = [REDLINE_BAR_CLASS, model.urgency];
  if (model.stale) classes.push('stale');

  if (snapshot === null || snapshot.entries.length === 0) {
    return {
      text: `Redline ${pctText(null)}`,
      tooltip: clipTooltip([model.tooltip, '', CLICK_HINT]),
      class: classes,
    };
  }

  const worst = worstBarWindow(entriesForBar(snapshot));
  const used = worst?.usedRatio ?? null;
  // Dado velho continua mostrado, mas com `?`: o número pode não valer mais.
  const text = `${barsText(used)} ${pctText(used)}${model.stale && used !== null ? '?' : ''}`;
  if (!model.stale && (model.urgency === 'warn' || model.urgency === 'danger')) classes.push('active');

  const output: RedlineBarOutput = {
    text,
    tooltip: clipTooltip([...tooltipLines(model.items), '', CLICK_HINT]),
    class: classes,
  };
  if (used !== null) output.percentage = Math.round(Math.min(1, Math.max(0, used)) * 100);
  return output;
}

/** Uma linha de JSON, como o Waybar e o Omarchy esperam. */
export function formatRedlineBarJson(output: RedlineBarOutput): string {
  return JSON.stringify(output);
}
