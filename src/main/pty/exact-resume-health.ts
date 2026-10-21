/**
 * F-721 — a retomada exata (`--resume <id>`) de um pane precisa poder DESISTIR
 * do id quando ele nunca vai funcionar.
 *
 * O id vem de um hook (SessionStart) ou da telemetria: nada garante que a
 * conversa dele chegou a virar transcrito (sessão aberta e fechada sem uma
 * mensagem, retenção da CLI, pasta de config trocada). Um `--resume` desses
 * sai com erro em segundos — e, como "Retomar" copia o MESMO id, a missão
 * ficaria presa até estourar o orçamento de respawns. Antes do F-721 o Maestro
 * restaurado sempre subia limpo, então isto seria uma regressão.
 *
 * Regra: uma saída rápida com o erro da própria CLI (código 1) de um `--resume`
 * que o Nexus NÃO pediu para encerrar é um golpe contra aquele (projeto, CLI,
 * id da conversa) — e NÃO contra o pane: cada "Retomar" do Maestro abre um pane
 * novo, e o id velho segue o mesmo. No segundo golpe o vínculo é esquecido e a
 * restauração seguinte nasce limpa, sob o mesmo contrato selado. Um boot que
 * sobrevive (ou sai limpo) prova o id e zera tudo. Duas tentativas (e não uma)
 * evitam perder a conversa por um tropeço único; só o código 1 conta, para que
 * falha de AMBIENTE (binário ausente 126/127, gate do SO 76, morto 137/143)
 * nunca apague vínculo nenhum.
 *
 * Puro: sem relógio, sem I/O, sem Electron; o chamador entrega o uptime.
 */

/** Saída com erro abaixo disto é "o resume não pegou" (mesma régua do renderer). */
export const EXACT_RESUME_FAST_EXIT_MS = 10_000;
export const EXACT_RESUME_STRIKES_TO_FORGET = 2;
/** O erro genérico da CLI ("no conversation found" etc.); o resto é ambiente. */
const CLI_ERROR_EXIT_CODE = 1;
const MAX_TRACKED_ATTEMPTS = 1_024;

export interface ExactResumeAttempt {
  readonly scope: {
    readonly installationId: string;
    readonly projectId: string;
    readonly checkoutId: string;
  };
  readonly adapterId: string;
  readonly sessionId: string;
}

export interface ExactResumeExit {
  readonly exitCode: number;
  readonly uptimeMs: number;
  /** O próprio Nexus pediu o encerramento (respawn, fechamento): não diz nada sobre o id. */
  readonly deliberate: boolean;
  /**
   * A própria CLI disse na tela que a conversa não existe ("No conversation
   * found with session ID"). É prova explícita, não palpite: um golpe basta.
   */
  readonly conversationMissing?: boolean;
}

/**
 * A CLI Claude diz, na tela, que o `--resume` apontou para conversa sem
 * transcrito ("No conversation found with session ID: <uuid>"). Lê só a janela
 * de saída em memória; o texto nunca sai daqui nem vai ao trace.
 */
const CONVERSATION_MISSING_PATTERN = /no conversation found with session id/i;
// eslint-disable-next-line no-control-regex -- ESC e BEL delimitam as sequências CSI/OSC que este padrão tira da tela antes de procurar a frase da CLI
const ANSI_SEQUENCE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function exactResumeScreenSaysConversationMissing(
  replay: ReadonlyArray<{ readonly data: string }>,
): boolean {
  let text = "";
  for (const chunk of replay) {
    text += chunk.data;
    if (text.length > 64_000) text = text.slice(-64_000);
  }
  return CONVERSATION_MISSING_PATTERN.test(text.replace(ANSI_SEQUENCE_PATTERN, ""));
}

export type ExactResumeVerdict = 'ok' | 'strike' | 'forget' | 'ignored';

function keyOf(attempt: ExactResumeAttempt): string {
  const { installationId, projectId, checkoutId } = attempt.scope;
  return JSON.stringify([installationId, projectId, checkoutId, attempt.adapterId, attempt.sessionId]);
}

export function createExactResumeHealth() {
  const strikes = new Map<string, number>();
  return {
    judge(attempt: ExactResumeAttempt, exit: ExactResumeExit): ExactResumeVerdict {
      const key = keyOf(attempt);
      const survived = exit.uptimeMs >= EXACT_RESUME_FAST_EXIT_MS;
      // Sobreviver ao boot prova o id, mesmo que o Nexus o encerre depois.
      if (survived || exit.exitCode === 0) {
        strikes.delete(key);
        return 'ok';
      }
      // Morte rápida pedida pelo Nexus, ou falha que não é o erro da CLI: não diz nada sobre o id.
      if (exit.deliberate || exit.exitCode !== CLI_ERROR_EXIT_CODE) return 'ignored';
      if (exit.conversationMissing === true) {
        strikes.delete(key);
        return 'forget';
      }
      const count = (strikes.get(key) ?? 0) + 1;
      if (count >= EXACT_RESUME_STRIKES_TO_FORGET) {
        strikes.delete(key);
        return 'forget';
      }
      // Reinsere no fim: o mapa mantém os mais recentes e o teto nunca estoura.
      strikes.delete(key);
      strikes.set(key, count);
      while (strikes.size > MAX_TRACKED_ATTEMPTS) {
        const oldest = strikes.keys().next().value;
        if (oldest === undefined) break;
        strikes.delete(oldest);
      }
      return 'strike';
    },
    size: () => strikes.size,
  };
}

export type ExactResumeHealth = ReturnType<typeof createExactResumeHealth>;
