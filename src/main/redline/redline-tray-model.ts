/**
 * Nexus Redline (Linux) — modelo da bandeja: snapshot validado → descrição do
 * menu, tooltip e urgência do ícone.
 *
 * Puro de propósito (sem electron, sem fs, relógio por parâmetro): é aqui que
 * mora toda a decisão e a formatação, espelhando `redline-model.cc` do
 * Windows e `main.swift` do Mac — arredondamento de percentual, barra de 5
 * blocos, limiares de urgência (≥85% crítico, ≥60% atenção), pior janela da
 * faixa, recomendação por maior folga e 10 min até o dado ficar velho.
 *
 * Diferença honesta para os companheiros: no Linux o Redline roda DENTRO do
 * Nexus, então "Nexus offline" não existe; o dado velho vira "leitura
 * desatualizada". Desconhecido nunca vira 0% — aparece como "—".
 *
 * O menu é uma lista nativa (Wayland não deixa a bandeja posicionar painel):
 * linhas `info` (desabilitadas), `action`, `separator` e um submenu para as
 * contas que não cabem na faixa.
 */

import {
  REDLINE_STATUS_BAR_MAX,
  type RedlineEntry,
  type RedlineRankingRow,
  type RedlineSnapshotFile,
  type RedlineWindow,
} from '../../shared/redline-types';

export type RedlineUrgency = 'unknown' | 'ok' | 'warn' | 'danger';
export type RedlineTrayAction = 'refresh' | 'open-quota' | 'hide';

export type RedlineMenuItem =
  | { kind: 'info'; text: string }
  | { kind: 'separator' }
  | { kind: 'action'; action: RedlineTrayAction; text: string }
  | { kind: 'submenu'; text: string; items: RedlineMenuItem[] };

export interface RedlineTrayModel {
  /** Cor do ícone: urgência da pior janela da faixa. */
  urgency: RedlineUrgency;
  /** Snapshot além de 10 min (o ícone mostra o ponto vazado). */
  stale: boolean;
  /** Há snapshot válido por trás do modelo. */
  hasData: boolean;
  tooltip: string;
  items: RedlineMenuItem[];
}

/** Dado com mais de 10 min é velho (igual ao Mac e ao Windows). */
export const REDLINE_STALE_MS = 10 * 60 * 1000;
export const REDLINE_DANGER_RATIO = 0.85;
export const REDLINE_WARN_RATIO = 0.6;
const BAR_BLOCKS = 5;
const TOOLTIP_MAX = 120;
const MAX_WINDOWS_SHOWN = 4;
const MAX_OTHER_ACCOUNTS = 25;
const HEADER_LABEL_MAX = 40;
const WINDOW_LABEL_MAX = 24;
const INDENT = '  ';
const SEP = ' · ';
const DASH = '—';
const MAX_DAYS_SHOWN = 99;

const BAR_KINDS: ReadonlySet<string> = new Set(['hours', 'session', 'weekly', 'monthly']);

// ── Formatação (espelho de redline-model.cc) ────────────────────────────────

export function urgencyFor(used: number | null): RedlineUrgency {
  if (used === null) return 'unknown';
  if (used >= REDLINE_DANGER_RATIO) return 'danger';
  if (used >= REDLINE_WARN_RATIO) return 'warn';
  return 'ok';
}

const URGENCY_WORD: Record<RedlineUrgency, string> = {
  danger: 'crítico',
  warn: 'atenção',
  ok: 'ok',
  unknown: 'sem leitura',
};

export function urgencyWord(urgency: RedlineUrgency): string {
  return URGENCY_WORD[urgency];
}

/** "62%"; desconhecido é "—", nunca "0%". */
export function pctText(used: number | null): string {
  return used === null ? DASH : `${Math.round(used * 100)}%`;
}

/** Barra de 5 blocos; desconhecido é "·····". */
export function barsText(used: number | null): string {
  if (used === null) return '·'.repeat(BAR_BLOCKS);
  const clamped = Math.min(1, Math.max(0, used));
  const filled = Math.round(clamped * BAR_BLOCKS);
  return '▮'.repeat(filled) + '▯'.repeat(BAR_BLOCKS - filled);
}

/**
 * Duração curta até um instante: "38m", "1h20", "12h", "6d". Menos de 1 min
 * sobe para "1m" (arredonda para cima, como os companheiros). `null` quando o
 * instante é desconhecido; "agora" quando já passou.
 */
export function durationText(targetMs: number | undefined, nowMs: number): string | null {
  if (targetMs === undefined || !Number.isFinite(targetMs)) return null;
  const remaining = targetMs - nowMs;
  if (remaining <= 0) return 'agora';
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, '0')}`;
  const days = Math.ceil(totalMinutes / 60 / 24);
  return days > MAX_DAYS_SHOWN ? `${MAX_DAYS_SHOWN}d+` : `${days}d`;
}

/** "reset em 1h20" / "reset agora" / "" (sem horário conhecido). */
export function resetText(resetsAt: number | undefined, nowMs: number): string {
  const duration = durationText(resetsAt, nowMs);
  if (duration === null) return '';
  return duration === 'agora' ? 'reset agora' : `reset em ${duration}`;
}

export function ageLabel(updatedAtMs: number, nowMs: number): string {
  const seconds = Math.trunc((nowMs - updatedAtMs) / 1000);
  if (seconds < 90) return 'agora mesmo';
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.trunc(minutes / 60);
  if (hours < 36) return `há ${hours}h`;
  return `há ${Math.trunc(hours / 24)}d`;
}

/** Relógio adiantado em até 5 min ainda é "agora"; além disso o dado não é de fiar. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isStale(updatedAtMs: number, nowMs: number): boolean {
  const ageMs = nowMs - updatedAtMs;
  return ageMs > REDLINE_STALE_MS || ageMs < -FUTURE_SKEW_MS;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  glm: 'GLM',
  opencode: 'OpenCode',
  agy: 'Antigravity',
  antigravity: 'Antigravity',
  'minimax-code': 'MiniMax Code',
};

export function providerName(adapterId: string): string {
  // `hasOwn`: "constructor"/"toString" não podem resolver para a Object.prototype.
  if (Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, adapterId)) {
    return PROVIDER_NAMES[adapterId];
  }
  return adapterId === '' ? adapterId : adapterId.charAt(0).toUpperCase() + adapterId.slice(1);
}

function clip(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

const WINDOW_LABEL_RULES: ReadonlyArray<readonly [RegExp, (match: RegExpMatchArray) => string]> = [
  [/^(\d{1,3})\s*(?:h|hr|hrs|hora|horas|hour|hours)$/, (m) => `${m[1]}h`],
  [/^sess(?:ão|ao|ion)$/, () => 'sessão'],
  [/^(?:semana|semanal|week|weekly)$/, () => 'semana'],
  [/^(?:mês|mes|mensal|month|monthly)$/, () => 'mês'],
  [/^(?:dia|diário|diario|day|daily)$/, () => 'dia'],
];

const KIND_FALLBACK: Readonly<Record<string, string>> = {
  hours: 'horas',
  session: 'sessão',
  weekly: 'semana',
  monthly: 'mês',
  credits: 'créditos',
  local: 'local',
};

/**
 * Nome curto da janela para a linha do menu: "5 Horas" → "5h", "Semanal" →
 * "semana". Só rótulo simples é abreviado; um rótulo específico ("Opus
 * semanal") fica como está para duas janelas da mesma conta não colidirem.
 */
export function compactWindowLabel(window: Pick<RedlineWindow, 'kind' | 'label'>): string {
  const label = window.label.trim();
  const normalized = label.normalize('NFC').toLowerCase();
  for (const [pattern, build] of WINDOW_LABEL_RULES) {
    const match = normalized.match(pattern);
    if (match) return build(match);
  }
  if (label !== '') return clip(label, WINDOW_LABEL_MAX);
  return KIND_FALLBACK[window.kind] ?? window.kind;
}

// ── Seleção (espelho de entriesForBar / worstBarWindow / bestRankingPick) ───

function hasReading(entry: RedlineEntry): boolean {
  return entry.windows.some((window) => window.usedRatio !== null);
}

/**
 * Contas da faixa na ordem do snapshot: as de `statusBarEntryIds`; sem ids
 * (ou ids que não casam com nenhuma conta) cai nas primeiras 6 com leitura.
 */
export function entriesForBar(snapshot: RedlineSnapshotFile): RedlineEntry[] {
  if (snapshot.statusBarEntryIds.length > 0) {
    const wanted = new Set(snapshot.statusBarEntryIds);
    // Teto 6 mesmo que o arquivo cite mais ids: o menu não cresce sem limite.
    const picked = snapshot.entries
      .filter((entry) => wanted.has(entry.id))
      .slice(0, REDLINE_STATUS_BAR_MAX);
    if (picked.length > 0) return picked;
  }
  return snapshot.entries.filter(hasReading).slice(0, REDLINE_STATUS_BAR_MAX);
}

export interface WorstWindow {
  entry: RedlineEntry;
  window: RedlineWindow;
  usedRatio: number;
}

/** Maior consumo conhecido (hours/session/weekly/monthly) entre as contas da faixa. */
export function worstBarWindow(entries: readonly RedlineEntry[]): WorstWindow | null {
  let worst: WorstWindow | null = null;
  for (const entry of entries) {
    for (const window of entry.windows) {
      if (!BAR_KINDS.has(window.kind) || window.usedRatio === null) continue;
      if (worst === null || window.usedRatio > worst.usedRatio) {
        worst = { entry, window, usedRatio: window.usedRatio };
      }
    }
  }
  return worst;
}

/** Linha de maior folga em todo o ranking; empate fica com a primeira. */
export function bestRankingPick(snapshot: RedlineSnapshotFile): RedlineRankingRow | null {
  let best: RedlineRankingRow | null = null;
  for (const rows of Object.values(snapshot.ranking)) {
    for (const row of rows) {
      if (best === null || row.headroom > best.headroom) best = row;
    }
  }
  return best;
}

// ── Montagem do menu ────────────────────────────────────────────────────────

function info(text: string): RedlineMenuItem {
  return { kind: 'info', text };
}

function accountTitle(entry: RedlineEntry): string {
  const provider = providerName(entry.adapterId);
  if (entry.label === '') return provider;
  return entry.label.toLowerCase().includes(provider.toLowerCase())
    ? entry.label
    : `${provider}${SEP}${entry.label}`;
}

/** Aviso em palavras: espera, sem credencial, sessão expirada. */
export function accountState(entry: RedlineEntry, nowMs: number): string {
  const parts: string[] = [];
  if (entry.onCooldown) {
    const left = durationText(entry.cooldownUntil, nowMs);
    parts.push(left === null ? 'Em espera' : `Em espera${SEP}${left}`);
  }
  if (entry.excludedReason === 'no-credential') parts.push('Sem credencial');
  else if (entry.excludedReason === 'needs-relogin') parts.push('Sessão expirada');
  else if (entry.excludedReason === 'cooldown' && !entry.onCooldown) parts.push('Em espera');
  return parts.join(SEP);
}

function windowLine(window: RedlineWindow, nowMs: number): string {
  const label = compactWindowLabel(window);
  if (window.usedRatio === null) {
    return `${INDENT}${label} ${barsText(null)} ${DASH}${SEP}sem leitura`;
  }
  const reset = resetText(window.resetsAt, nowMs);
  return `${INDENT}${label} ${barsText(window.usedRatio)} ${pctText(window.usedRatio)}${reset === '' ? '' : `${SEP}${reset}`}`;
}

function accountBlock(
  entry: RedlineEntry,
  nowMs: number,
  recommendedId: string | null,
): RedlineMenuItem[] {
  const tags: string[] = [];
  if (entry.active) tags.push('ativa');
  if (recommendedId !== null && entry.id === recommendedId) tags.push('recomendada ★');
  const heading = [accountTitle(entry), ...tags].join(SEP);
  const items: RedlineMenuItem[] = [info(heading)];
  if (entry.emailMasked && !entry.label.includes(entry.emailMasked)) {
    items.push(info(`${INDENT}${entry.emailMasked}`));
  }
  const state = accountState(entry, nowMs);
  if (state !== '') items.push(info(`${INDENT}${state}`));
  if (entry.windows.length === 0) {
    items.push(info(`${INDENT}Sem leitura de cota`));
    return items;
  }
  for (const window of entry.windows.slice(0, MAX_WINDOWS_SHOWN)) {
    items.push(info(windowLine(window, nowMs)));
  }
  return items;
}

function otherAccountLine(entry: RedlineEntry, nowMs: number): string {
  const peak = worstBarWindow([entry]);
  const reading = peak
    ? `${pctText(peak.usedRatio)} ${compactWindowLabel(peak.window)}`
    : 'sem leitura';
  const state = accountState(entry, nowMs);
  return [accountTitle(entry), reading, ...(state === '' ? [] : [state])].join(SEP);
}

function otherAccountsSubmenu(
  others: readonly RedlineEntry[],
  nowMs: number,
): RedlineMenuItem | null {
  if (others.length === 0) return null;
  const items = others.slice(0, MAX_OTHER_ACCOUNTS).map((entry) => info(otherAccountLine(entry, nowMs)));
  const rest = others.length - MAX_OTHER_ACCOUNTS;
  if (rest > 0) items.push(info(`… e mais ${rest}`));
  return { kind: 'submenu', text: `Outras contas (${others.length})`, items };
}

const FOOTER: RedlineMenuItem[] = [
  { kind: 'separator' },
  { kind: 'action', action: 'refresh', text: 'Atualizar agora' },
  { kind: 'action', action: 'open-quota', text: 'Abrir cotas no Nexus' },
  { kind: 'separator' },
  { kind: 'action', action: 'hide', text: 'Ocultar da bandeja' },
];

function emptyModel(): RedlineTrayModel {
  return {
    urgency: 'unknown',
    stale: true,
    hasData: false,
    tooltip: 'Nexus Redline · aguardando a primeira leitura de cotas do Nexus.',
    items: [
      info('Redline · sem dados de cota ainda'),
      info(`${INDENT}As contas aparecem aqui quando o Nexus atualizar as cotas.`),
      ...FOOTER,
    ],
  };
}

function headerLine(worst: WorstWindow | null, urgency: RedlineUrgency): string {
  if (worst === null) return `Redline${SEP}sem leitura de cota nas contas`;
  const where = `${pctText(worst.usedRatio)} (${compactWindowLabel(worst.window)}) em ${clip(accountTitle(worst.entry), HEADER_LABEL_MAX)}`;
  return `Redline${SEP}pior janela ${where}${SEP}${urgencyWord(urgency)}`;
}

function tooltipText(
  snapshot: RedlineSnapshotFile,
  worst: WorstWindow | null,
  stale: boolean,
  nowMs: number,
): string {
  const count = snapshot.entries.length;
  const parts = [
    'Nexus Redline',
    `${count} ${count === 1 ? 'conta' : 'contas'}`,
    worst === null
      ? 'sem leitura'
      : `${pctText(worst.usedRatio)} em ${accountTitle(worst.entry)}`,
    ageLabel(snapshot.updatedAt, nowMs),
  ];
  if (stale) parts.push('leitura desatualizada');
  return clip(parts.join(SEP), TOOLTIP_MAX);
}

function freshnessLine(snapshot: RedlineSnapshotFile, stale: boolean, nowMs: number): string {
  const providers = new Set(snapshot.entries.map((entry) => entry.adapterId)).size;
  const accounts = snapshot.entries.length;
  const base =
    `${providers} ${providers === 1 ? 'provedor' : 'provedores'}${SEP}` +
    `${accounts} ${accounts === 1 ? 'conta' : 'contas'}${SEP}` +
    `atualizado ${ageLabel(snapshot.updatedAt, nowMs)}`;
  return `${INDENT}${stale ? `${base}${SEP}leitura desatualizada` : base}`;
}

/** Snapshot (ou `null`) + relógio → tudo que a bandeja precisa desenhar. */
export function buildRedlineTrayModel(
  snapshot: RedlineSnapshotFile | null,
  nowMs: number,
): RedlineTrayModel {
  if (snapshot === null || snapshot.entries.length === 0) return emptyModel();

  const bar = entriesForBar(snapshot);
  const worst = worstBarWindow(bar);
  const urgency = urgencyFor(worst?.usedRatio ?? null);
  const stale = isStale(snapshot.updatedAt, nowMs);

  // Nenhuma conta com leitura: ainda assim mostra as primeiras, para os avisos
  // (sem credencial, sessão expirada) ficarem visíveis.
  const shown = bar.length > 0 ? bar : snapshot.entries.slice(0, REDLINE_STATUS_BAR_MAX);
  const shownIds = new Set(shown.map((entry) => entry.id));
  const others = snapshot.entries.filter((entry) => !shownIds.has(entry.id));
  const recommendedId = bestRankingPick(snapshot)?.entryId ?? null;

  const items: RedlineMenuItem[] = [
    info(headerLine(worst, urgency)),
    info(freshnessLine(snapshot, stale, nowMs)),
    { kind: 'separator' },
  ];
  shown.forEach((entry, index) => {
    if (index > 0) items.push({ kind: 'separator' });
    items.push(...accountBlock(entry, nowMs, recommendedId));
  });
  const submenu = otherAccountsSubmenu(others, nowMs);
  if (submenu) items.push({ kind: 'separator' }, submenu);
  items.push(...FOOTER);

  return {
    urgency,
    stale,
    hasData: true,
    tooltip: tooltipText(snapshot, worst, stale, nowMs),
    items,
  };
}
