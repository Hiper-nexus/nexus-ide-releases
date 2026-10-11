/** F-1167: formatos curtos do motor de decisão (pt-BR). */

/** US$ com vírgula; centavos de centavo ganham 4 casas, nunca "US$ 0,00" para gasto real. */
export function formatDecisionUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return 'US$ 0,00';
  if (usd < 0.0001) return '< US$ 0,0001';
  const digits = usd < 1 ? 4 : 2;
  return `US$ ${usd.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatDecisionPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  if (ratio < 0.01) return '< 1%';
  return `${Math.round(ratio * 100)}%`;
}

export function formatDecisionTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—';
  return new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** "0,50", "0.5" ou "1" → número; fora de 0–20 ou texto inválido → null. */
export function parseMissionBudgetInput(text: string, max = 20): number | null {
  const normalized = text.trim().replace(/^US\$\s*/i, '').replace(',', '.');
  if (!/^\d{1,2}(?:\.\d{1,4})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}
