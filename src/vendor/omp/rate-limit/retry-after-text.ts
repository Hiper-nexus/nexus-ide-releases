// Derived from can1357/oh-my-pi@03c48d073 packages/ai/src/utils/retry-after.ts (MIT)
/**
 * Extração de hint de reset ("volte em X") a partir de TEXTO.
 *
 * O omp extrai esses sinais de headers HTTP (`Headers`/objeto) da resposta que
 * falhou. O Nexus lê PTY — não temos headers, mas os MESMOS sinais aparecem
 * ecoados como texto (o hint `retry-after-ms=` que o próprio omp embute na
 * mensagem, headers impressos por `curl -i`/SDKs, e prosa "retry in 26.3s").
 * A parte de acesso a `Headers` foi descartada; as heurísticas numéricas
 * (delta vs epoch de `x-ratelimit-reset`) foram preservadas.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Converte valor+unidade de prosa ("26.3" + "s") em ms. */
function unitToMs(value: number, unit: string): number {
  const u = unit.toLowerCase();
  // "ms"/"millisecond(s)" antes de "m" — ambos começam com 'm'.
  if (u.startsWith('ms') || u.startsWith('millisecond')) return value;
  if (u.startsWith('h')) return value * HOUR_MS;
  if (u.startsWith('m')) return value * MINUTE_MS;
  return value * 1000; // s / sec / seconds
}

/**
 * Heurística do omp (parseResetHeader) para `x-ratelimit-reset(-ms)`:
 * valores enormes são epoch (ms ou s), valores pequenos são delta.
 */
function resetValueToDeltaMs(numeric: number, unit: 'ms' | 's', now: number): number | null {
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  let targetMs: number | null = null;
  if (numeric > 1e12) {
    targetMs = numeric; // epoch em ms
  } else if (numeric > 1e9) {
    targetMs = numeric * 1000; // epoch em segundos
  } else {
    // Delta puro na unidade do header.
    return Math.ceil(unit === 'ms' ? numeric : numeric * 1000);
  }

  if (targetMs <= now) return null;
  return Math.ceil(targetMs - now);
}

/**
 * Procura no texto qualquer hint de "quando tentar de novo" e devolve o MAIOR
 * candidato em ms (mesma escolha do omp: `Math.max` entre os sinais), ou null
 * se não houver hint. Nunca inventa: só números explícitos no texto.
 */
export function parseRetryAfterMsFromText(text: string, now: number = Date.now()): number | null {
  const candidates: number[] = [];
  const push = (ms: number | null): void => {
    if (ms !== null && Number.isFinite(ms) && ms > 0) candidates.push(Math.ceil(ms));
  };

  // 1. Hint do próprio omp embutido na mensagem: "retry-after-ms=1234".
  //    Também cobre o header ecoado "retry-after-ms: 1234".
  const hintMs = /retry-after-ms\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(text);
  if (hintMs) push(Number(hintMs[1]));

  // 2. Header "retry-after: 30" ecoado no terminal — segundos (RFC 9110).
  //    O lookahead evita re-casar o "retry-after-ms" do item 1.
  const retryAfter = /\bretry-after(?!-ms)\s*[:=]\s*"?(\d+(?:\.\d+)?)\b/i.exec(text);
  if (retryAfter) push(Number(retryAfter[1]) * 1000);

  // 3. Header "retry-after: <HTTP-date>" — delta até a data (se futura).
  const retryAfterDate =
    /\bretry-after(?!-ms)\s*[:=]\s*"?([A-Za-z]{3},\s?\d{1,2}\s[A-Za-z]{3}\s\d{4}\s\d{2}:\d{2}:\d{2}\s(?:GMT|UTC))/i.exec(text);
  if (retryAfterDate) {
    const dateMs = Date.parse(retryAfterDate[1]);
    if (!Number.isNaN(dateMs) && dateMs > now) push(dateMs - now);
  }

  // 4. Headers de reset ecoados, com a heurística delta/epoch do omp.
  const resetMs = /\bx-ratelimit-reset-ms\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(text);
  if (resetMs) push(resetValueToDeltaMs(Number(resetMs[1]), 'ms', now));
  const resetS = /\bx-ratelimit-reset(?!-ms)\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(text);
  if (resetS) push(resetValueToDeltaMs(Number(resetS[1]), 's', now));

  // 5. Prosa de provider: "please retry in 26.3s", "retrying after 2 minutes".
  //    (O estilo "try again in N minutes" já é tratado pelo legado do Nexus.)
  const prose =
    /\bretry(?:ing)?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|secs?|seconds?|s|mins?|minutes?|m|hrs?|hours?|h)\b/i.exec(text);
  if (prose) push(unitToMs(Number(prose[1]), prose[2]));

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}
