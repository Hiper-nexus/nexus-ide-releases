/**
 * Camada 2 da rotação proativa: a rede de segurança.
 *
 * A camada 1 tira o trabalho NOVO de uma conta que se aproxima do fim, na
 * borda de tarefa, sem interromper ninguém. Sobra o pane longo que esgota no
 * meio do próprio trabalho — esse não tem borda para esperar, e é o que
 * parava a missão do cliente.
 *
 * Duas travas, ambas de anti-objetivo:
 *  - **Trabalho pendente é obrigatório.** Um pane ocioso porque TERMINOU não
 *    pode receber pacote de continuidade: inventaria trabalho e tokens.
 *  - **Só esgotamento.** Drenagem é da camada 1. Trocar um pane vivo por
 *    drenagem interromperia quem ainda tem fatia para terminar.
 *
 * Puro: o efeito (religar o pane) é do `delegation-supervisor`.
 */
import {
  isHeadroomDraining,
  type DrainEvidence,
  type HeadroomInput,
} from '../quota/account-headroom';

/** Uma troca a quente por pane por hora — trava anti-cascata. */
export const DRAIN_SWAP_COOLDOWN_MS = 60 * 60_000;

/** `usedRatio >= 1` provado pela mesma evidência que autoriza a drenagem. */
const EXHAUSTED_RATIO = 1;

export interface DrainSwapInput {
  readonly headroom: HeadroomInput | undefined;
  /** Há entrega esperando este pane? Sem isso a troca inventaria trabalho. */
  readonly hasPendingWork: boolean;
  /** Última troca a quente deste pane, para o teto. */
  readonly lastSwapAt: number | null;
  readonly evidence: DrainEvidence;
}

export interface DrainSwapDecision {
  readonly swap: boolean;
  readonly reason: string;
}

export function decideDrainSwap(input: DrainSwapInput): DrainSwapDecision {
  if (!input.headroom) return { swap: false, reason: 'sem leitura de cota' };
  if (!input.hasPendingWork) {
    return { swap: false, reason: 'pane ocioso sem trabalho pendente' };
  }
  if (
    input.lastSwapAt !== null &&
    input.evidence.now - input.lastSwapAt < DRAIN_SWAP_COOLDOWN_MS
  ) {
    return { swap: false, reason: 'teto de uma troca a quente por hora' };
  }
  if (!isHeadroomDraining(input.headroom, EXHAUSTED_RATIO, input.evidence)) {
    return { swap: false, reason: 'a conta não esgotou (medida, fresca)' };
  }
  return { swap: true, reason: 'conta esgotada com trabalho pendente' };
}
