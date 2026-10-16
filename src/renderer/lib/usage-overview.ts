import type { CSSProperties } from 'react';
import type { UsageMetric } from '../../shared/usage-types';

/**
 * Apresentação do painel de Uso e custos (estilo "Usage" do T3): rótulos,
 * cor de série por provedor e formatos de número. Puro, sem DOM.
 */

/** Slots `--series-1..6` de base.css; acima disso a série vira "Outros". */
const USAGE_SERIES_SLOTS = 6;

/**
 * A cor segue a FERRAMENTA, nunca a posição no ranking: Claude é sempre o
 * mesmo laranja, mesmo quando outra ferramenta passa à frente no custo.
 */
const PROVIDER_SERIES: Readonly<Record<string, number>> = {
  codex: 1,
  openai: 1,
  claude: 2,
  anthropic: 2,
  agy: 3,
  antigravity: 3,
  gemini: 3,
  grok: 4,
  xai: 4,
  'mimo-code': 5,
  mimo: 5,
  'cursor-agent': 6,
  cursor: 6,
};

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  anthropic: 'Anthropic',
  codex: 'Codex',
  openai: 'OpenAI',
  agy: 'Antigravity',
  antigravity: 'Antigravity',
  gemini: 'Gemini',
  grok: 'Grok Build',
  xai: 'xAI',
  'mimo-code': 'MiMo Code',
  mimo: 'MiMo',
  'cursor-agent': 'Cursor',
  cursor: 'Cursor',
  glm: 'GLM',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  'minimax-code': 'MiniMax Code',
  opencode: 'OpenCode',
};

export function usageProviderLabel(provider: string): string {
  const known = PROVIDER_LABELS[provider];
  if (known) return known;
  const words = provider.split(/[-_\s]+/u).filter(Boolean);
  return words.length > 0
    ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    : provider;
}

/**
 * Slot de cor (1..6) para cada provedor presente; `null` = dobra em "Outros"
 * (tinta neutra). Conhecidos têm slot fixo; os demais pegam, em ordem
 * alfabética, o primeiro slot livre — nunca um matiz gerado.
 */
export function assignUsageSeries(providers: readonly string[]): Map<string, number | null> {
  const assigned = new Map<string, number | null>();
  const used = new Set<number>();
  const unknown: string[] = [];
  for (const provider of [...new Set(providers)]) {
    const slot = PROVIDER_SERIES[provider];
    if (slot !== undefined && !used.has(slot)) {
      assigned.set(provider, slot);
      used.add(slot);
    } else {
      unknown.push(provider);
    }
  }
  for (const provider of unknown.sort((a, b) => a.localeCompare(b))) {
    let slot: number | null = null;
    for (let candidate = 1; candidate <= USAGE_SERIES_SLOTS; candidate += 1) {
      if (!used.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    if (slot !== null) used.add(slot);
    assigned.set(provider, slot);
  }
  return assigned;
}

/** Token `--series-1..6` do slot, ou a tinta neutra de "Outros". */
function usageSeriesColor(slot: number | null | undefined): string {
  return slot ? `var(--series-${slot})` : 'var(--text-faint)';
}

/**
 * A série entra no CSS como `--usage-series`; fill/stroke/fundo saem das
 * regras de `usage-overview.css`, nunca de cor escrita no componente.
 */
export function usageSeriesStyle(slot: number | null | undefined): CSSProperties {
  return { '--usage-series': usageSeriesColor(slot) } as CSSProperties;
}

const usdFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `$3,475.17` — dólar com milhar e centavos (mesmo registro de `fmtUsd`). */
export function formatUsdAmount(value: number): string {
  return usdFormat.format(Number.isFinite(value) ? Math.max(0, value) : 0);
}

/** Eixo: `$800`, `$1.2k`, `$0.50` — curto, sem centavos acima de $100. */
export function formatUsdAxis(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (n === 0) return '$0';
  if (n >= 10_000) return `$${trimZero((n / 1_000).toFixed(n >= 100_000 ? 0 : 1))}k`;
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

function trimZero(text: string): string {
  return text.replace(/\.0$/u, '');
}

/**
 * Tokens em 3 algarismos significativos com sufixo: `900`, `12.4k`, `125M`,
 * `5.05B`, `10.9B` — a escala de bilhões do cache entra sem virar "10900M".
 */
export function formatTokenCount(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  if (n < 1_000) return String(n);
  const units: readonly [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (n >= size * 0.9995) {
      const scaled = n / size;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${trimTrailing(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return String(n);
}

function trimTrailing(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/u, '') : text;
}

const shareFormat = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** `46,8%` — mesma régua pt-BR das cotas; fatia ínfima não vira "0,0%". */
export function formatSharePercent(ratio: number): string {
  const value = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) * 100 : 0;
  if (value > 0 && value < 0.1) return '<0,1%';
  return `${shareFormat.format(value)}%`;
}

export function pluralize(count: number, one: string, many: string): string {
  return `${count.toLocaleString('pt-BR')} ${count === 1 ? one : many}`;
}

function dateFromDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
}

/** "16 set" — eixo do gráfico. */
export function dayTickLabel(day: string): string {
  return dateFromDay(day)
    .toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })
    .replace(/\.|\sde\s/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** "qua., 8 de out." — leitura do dia e tabela. */
export function dayLongLabel(day: string): string {
  return dateFromDay(day).toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** "8 out a 12 out" — um intervalo; um dia só vira "qua., 8 de out.". */
export function formatRangeLabel(from: string, to: string): string {
  return from === to ? dayLongLabel(from) : `${dayTickLabel(from)} a ${dayTickLabel(to)}`;
}

/** "2.18B tokens", mas "1 token": a unidade sempre escrita junto do número. */
export function formatTokensWithUnit(value: number): string {
  return `${formatTokenCount(value)} ${Math.round(value) === 1 ? 'token' : 'tokens'}`;
}

/**
 * Custo e tokens do mesmo recorte, na ordem da medida escolhida: a primeira
 * é o destaque, a outra fica ao lado — assim os tokens aparecem no modo Custo
 * e o custo no modo Tokens, sempre com a unidade escrita.
 */
export function usageMeasureTexts(
  metric: UsageMetric,
  costUsd: number,
  totalTokens: number,
): { readonly primary: string; readonly secondary: string } {
  const cost = formatUsdAmount(costUsd);
  const tokens = formatTokensWithUnit(totalTokens);
  return metric === 'cost' ? { primary: cost, secondary: tokens } : { primary: tokens, secondary: cost };
}

/** O número da medida sem a unidade (`$3,404.95` ou `2.18B`): a unidade vai escrita ao lado. */
export function usageMeasureValue(metric: UsageMetric, costUsd: number, totalTokens: number): string {
  return metric === 'cost' ? formatUsdAmount(costUsd) : formatTokenCount(totalTokens);
}
