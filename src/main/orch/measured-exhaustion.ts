/**
 * Camada 3.2 — o caso do relato: a CLI emudece em vez de imprimir um erro.
 *
 * `limit-signal-patterns.ts` não tem nenhuma entrada AGY/Gemini, e os padrões
 * genéricos exigem moldura de erro HTTP. Um AGY que esgota e para em silêncio
 * nunca produzia `LimitHit`, então `performSwitch` nunca era chamado e o pane
 * ficava parado até alguém notar. Era o relato do cliente, em qualquer
 * plataforma.
 *
 * Aqui a prova é a API do provedor, não o terminal — por isso não fere o
 * F-249 ("limite não confirmado não troca o pane"): o texto citado continua
 * sem valor, e o que autoriza é uma leitura `provider-api` fresca.
 *
 * O hit sintetizado entra no `commitLimitHit` que já existe, que já religa
 * orquestrador (rebind + pacote de continuidade), já respawna worker e já
 * encadeia para a troca de CLI quando não sobra conta (F-775 item 2).
 *
 * Deps injetáveis para manter isto testável fora do harness do failover.
 */
import { accountDrainEvidence } from '../persistence/account-drain-evidence';
import { decideDrainSwap } from './drain-watchdog';
import type { HeadroomInput } from '../quota/account-headroom';
import type { LimitHit } from './limit-detector';
import { SEMANTIC_WORKING_VETO_MS } from './agent-status';

/**
 * A razão do hit sintetizado vira `last_error` da conta e volta ao
 * `detectLimit` (`quota-service.ts`). Se um padrão futuro a reconhecer como
 * sinal de limite, fecha um laço de realimentação. Exportada para o teste
 * travar isso.
 */
export const MEASURED_EXHAUSTION_REASON =
  'cota medida esgotada pela API do provedor (pane em silêncio)';

/**
 * Quanto silêncio prova que o pane PAROU.
 *
 * `idle` do PTY só diz que nada foi impresso no timeout curto dele: um worker
 * pode estar numa chamada de API ou numa ferramenta silenciosa, sobretudo em
 * CLI sem hooks. Um único sample ocioso faria o scan de 15 s fechar um pane
 * que ainda trabalha, duplicando ou perdendo o trabalho em voo. Três minutos
 * é mais longo que qualquer rodada de modelo e mais curto que o travamento de
 * 20 min do F-242, que cuida do pane realmente preso.
 */
export const SUSTAINED_SILENCE_MS = 3 * 60_000;

/** Mesmo teto que a troca por limite de texto usa para conta esgotada. */
const MEASURED_EXHAUSTION_COOLDOWN_MS = 60 * 60_000;

export interface MeasuredExhaustionInput {
  readonly paneId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly accountId: string | null;
  /** Há entrega esperando este pane? Sem isso a troca inventaria trabalho. */
  readonly hasPendingWork: boolean;
  /** Há quanto tempo o PTY não imprime nada. `undefined` = não se sabe. */
  readonly silentForMs: number | undefined;
  /**
   * Quando a CLI reportou `working`, ou `null`. É instante, não booleano, de
   * propósito: a cota esgotada pode travar o pedido ao provedor ANTES do
   * evento de parada, e aí `working` ficaria verdadeiro para sempre — o veto
   * duraria eternamente e o pane nunca seria resgatado, justamente o caso que
   * esta camada existe para resolver.
   */
  readonly semanticWorkingAt: number | null;
  readonly now: number;
}

export interface MeasuredExhaustionDeps {
  headroomFor(adapterId: string, accountId: string): HeadroomInput | undefined;
  lastSwapAt(paneId: string): number | null;
  noteSwap(paneId: string, at: number): void;
  commitHit(input: { readonly sessionId: string; readonly hit: LimitHit }): void;
}

export interface MeasuredExhaustionResult {
  readonly acted: boolean;
  readonly reason: string;
}

export function reportMeasuredExhaustion(
  input: MeasuredExhaustionInput,
  deps: MeasuredExhaustionDeps,
): MeasuredExhaustionResult {
  if (!input.accountId) return { acted: false, reason: 'pane sem conta' };
  // A CLI diz que está trabalhando: nada de medição contra o próprio agente —
  // mas só enquanto a afirmação for recente, pelo mesmo prazo que o resto do
  // supervisor usa (`SEMANTIC_WORKING_VETO_MS`).
  if (
    input.semanticWorkingAt !== null &&
    input.now - input.semanticWorkingAt <= SEMANTIC_WORKING_VETO_MS
  ) {
    return { acted: false, reason: 'a CLI está trabalhando' };
  }
  if (
    input.silentForMs === undefined ||
    input.silentForMs < SUSTAINED_SILENCE_MS
  ) {
    return { acted: false, reason: 'silêncio ainda não sustentado' };
  }
  const headroom = deps.headroomFor(input.adapterId, input.accountId);
  // A leitura emprestada da identidade viva serve para DRENAR (perder
  // trabalho novo é recuperável e uma leitura fresca em contrário a desfaz),
  // mas não para cá: este caminho grava cooldown e rerroteia o pane. O bridge
  // do AGY não traz identidade e prefere o processo do IDE — com o
  // Antigravity aberto noutra conta, a leitura seria de um terceiro, e
  // puniríamos uma conta saudável enquanto a esgotada segue recebendo
  // trabalho. Aqui só vale a medição da própria conta.
  if (headroom?.attributed) {
    return { acted: false, reason: 'leitura não é própria da conta' };
  }
  const decision = decideDrainSwap({
    headroom,
    hasPendingWork: input.hasPendingWork,
    lastSwapAt: deps.lastSwapAt(input.paneId),
    evidence: accountDrainEvidence(input.now),
  });
  if (!decision.swap) return { acted: false, reason: decision.reason };
  const hit: LimitHit = {
    kind: 'quota',
    reason: MEASURED_EXHAUSTION_REASON,
    cooldownMs: MEASURED_EXHAUSTION_COOLDOWN_MS,
    adapterId: input.adapterId,
    // A medição É a confirmação: não há sonda a esperar.
    confirmedAt: input.now,
  };
  deps.commitHit({ sessionId: input.sessionId, hit });
  deps.noteSwap(input.paneId, input.now);
  return { acted: true, reason: decision.reason };
}
