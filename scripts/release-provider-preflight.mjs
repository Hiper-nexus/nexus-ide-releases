/**
 * Preflight de saúde dos provedores do gate de release.
 *
 * O gate roda uma missão REAL com CLIs de verdade. Quando um provedor para de
 * responder — cota, rate-limit, sessão expirada — o sintoma aparece ~40 minutos
 * depois, como "worker sem atividade e sem heartbeat por 10 minutos (stalled)",
 * e o ciclo inteiro é perdido. Numa noite de release isso se repetiu com
 * degradação monotônica no MESMO commit e MESMOS artefatos: 8/8 -> 7/7 -> 6/5
 * handoffs.
 *
 * A tabela `accounts` do nexus.db não revela: ela cobre as contas do vault,
 * enquanto grok, glm, agy, opencode e codex autenticam pelos próprios HOMEs.
 *
 * Este módulo decide, a partir de sondas baratas e limitadas por tempo, se o
 * ciclo deve começar. O núcleo é puro: quem executa processo é injetado, para
 * o teste provar a decisão sem tocar em provider nenhum.
 */

/** Provedor ausente não reprova o gate: o roster já trata CLI não instalada. */
export const PREFLIGHT_VERDICTS = Object.freeze([
  "healthy",
  "absent",
  "unresponsive",
  "unauthenticated",
]);

/**
 * Classifica UMA sonda. Separa "não existe" (o roster resolve) de "existe e não
 * responde" (o ciclo morreria 40 min depois) — a distinção que economiza o
 * ciclo. Timeout é o sinal mais valioso: é exatamente a forma que o
 * esgotamento de provedor assume.
 */
export function classifyProviderProbe(probe) {
  if (!probe || probe.installed !== true) return "absent";
  if (probe.timedOut === true) return "unresponsive";
  if (typeof probe.status !== "number") return "unresponsive";
  if (probe.status === 0) return "healthy";
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.toLowerCase();
  // Auth e cota falham com exit != 0; distingui-las muda o remédio que o
  // operador recebe (relogar vs esperar), então vale ler a saída.
  if (
    output.includes("login") ||
    output.includes("unauthorized") ||
    output.includes("authentication") ||
    output.includes("401")
  ) {
    return "unauthenticated";
  }
  return "unresponsive";
}

/**
 * Consolida o veredito do ciclo. Só `healthy` e `absent` deixam começar: um
 * provedor que existe e não responde é a causa provada de missão que pendura.
 */
export function summarizeProviderPreflight(results) {
  const blocking = results.filter(
    (result) =>
      result.verdict === "unresponsive" || result.verdict === "unauthenticated",
  );
  if (blocking.length === 0) {
    return Object.freeze({
      ok: true,
      blocking: Object.freeze([]),
      summary: "todos os provedores exigidos responderam",
    });
  }
  const detail = blocking
    .map((result) => `${result.cli} (${result.verdict})`)
    .join(", ");
  return Object.freeze({
    ok: false,
    blocking: Object.freeze([...blocking]),
    summary:
      `provedor não utilizável antes do gate: ${detail}. ` +
      "O ciclo de release levaria ~40 min para descobrir isso como worker " +
      "stalled. Corrija a sessão do provider (ou espere a cota) e repita.",
  });
}

/**
 * Executa o preflight. `probe` recebe o cli e devolve o resultado bruto; a
 * classificação e o veredito ficam nas funções puras acima.
 */
export async function runProviderPreflight(clis, probe) {
  const results = [];
  for (const cli of clis) {
    let raw = null;
    try {
      raw = await probe(cli);
    } catch (error) {
      // Sonda que explode conta como não-responsiva: o gate não pode começar
      // apostando que o provedor está bem.
      raw = {
        installed: true,
        timedOut: false,
        status: null,
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(
      Object.freeze({ cli, verdict: classifyProviderProbe(raw), probe: raw }),
    );
  }
  return Object.freeze({ results: Object.freeze(results), ...summarizeProviderPreflight(results) });
}
