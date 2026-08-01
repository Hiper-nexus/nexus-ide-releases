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
  // operador recebe (relogar/configurar chave vs esperar), então vale ler a
  // saída. Os padrões abaixo são os TEXTOS REAIS observados nas CLIs desta
  // release — "authenticat" como radical porque o Claude diz "Failed to
  // authenticate" e um match por "authentication" passava batido.
  const AUTH_MARKERS = [
    "authenticat", // claude: "Failed to authenticate: OAuth session expired"
    "login", // claude/grok: "Please run /login"
    "unauthorized",
    "401",
    "api key", // opencode: "OpenRouter API key is missing"
    "expired", // sessão OAuth expirada e irrecuperável
  ];
  if (AUTH_MARKERS.some((marker) => output.includes(marker))) {
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
 * Comandos de sonda CALIBRADOS contra os provedores reais desta máquina.
 * Cada entrada foi executada e teve a saída observada antes de virar bloqueio
 * de release — um preflight mal calibrado reprova release boa, que é pior que
 * o problema que ele resolve.
 *
 * `grok models` é sonda de AUTENTICAÇÃO e não gasta turno de LLM: devolve
 * "You are logged in with …". As demais custam um turno mínimo, o que é
 * ordens de grandeza mais barato que descobrir o mesmo 40 minutos depois.
 *
 * CLIs fora desta tabela NÃO são sondadas e nunca bloqueiam: preferir um
 * falso-negativo (deixar passar) a inventar um comando não validado e travar
 * release legítima por engano.
 */
export const PROVIDER_PROBE_MARKER = "NEXUS_PREFLIGHT_OK";

export const PROVIDER_PROBE_SPECS = Object.freeze({
  codex: Object.freeze({
    args: Object.freeze([
      "exec",
      "--skip-git-repo-check",
      `Responda exatamente ${PROVIDER_PROBE_MARKER} e nada mais.`,
    ]),
    kind: "turn",
  }),
  grok: Object.freeze({
    // Prova login sem gastar turno. Falha de auth aparece no exit != 0.
    args: Object.freeze(["models"]),
    kind: "auth",
  }),
  claude: Object.freeze({
    args: Object.freeze([
      "-p",
      `Responda exatamente ${PROVIDER_PROBE_MARKER} e nada mais.`,
    ]),
    kind: "turn",
  }),
});

/** CLIs do roster sem comando de sonda validado — documentado, não esquecido. */
export const PROVIDER_PROBE_UNCALIBRATED = Object.freeze([
  // agy exige TTY (o launcher do E2E tem o probe próprio dele);
  // kimi e glm não tiveram comando validado contra provedor saudável;
  // opencode autentica por credencial GERENCIADA que o Nexus injeta no spawn
  // (keyEnv do vault) — no shell do operador a sonda falha com "API key is
  // missing" enquanto o harness roda normalmente. Provado em campo: ele
  // entregou handoffs em todas as execuções da noite sem a variável no shell.
  // Sondar aqui daria falso negativo, o defeito que este módulo mais evita.
  "agy",
  "kimi",
  "glm",
  "opencode",
]);

export function providerProbeSpec(cli) {
  return PROVIDER_PROBE_SPECS[cli] ?? null;
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

/**
 * Sonda viva de um provedor. CLI sem spec calibrada devolve `absent` — nunca
 * bloqueia por comando adivinhado.
 */
export function probeProviderWithSpec(cli, runCommand) {
  const spec = providerProbeSpec(cli);
  if (!spec) return { installed: false, uncalibrated: true };
  const result = runCommand(cli, spec.args);
  const stdout = String(result?.stdout ?? "");
  const stderr = String(result?.stderr ?? "");
  if (result?.spawnFailed === true) {
    // Binário ausente do PATH: o roster resolve, não é falha de provedor.
    return { installed: false };
  }
  return {
    installed: true,
    timedOut: result?.timedOut === true,
    status: result?.status ?? null,
    stdout,
    stderr,
  };
}

/**
 * Provedores exigidos por uma missão do gate, filtrados aos que têm sonda
 * calibrada. Fonte é o roster real passado pelo chamador, para o preflight
 * nunca divergir do que a missão vai de fato usar.
 */
export function calibratedProvidersFrom(rosterClis) {
  return [...new Set(rosterClis)].filter((cli) => providerProbeSpec(cli) !== null);
}
