import { z } from 'zod';
import { ROUTE_EFFORTS, type RouteEffort } from './mission-route-specialty';

/**
 * Proposta de rota para o "+ Pane" e para o início de missão.
 *
 * É CONSULTIVA por construção: o renderer pede uma sugestão, mostra ao
 * operador e deixa ele mudar antes do pane nascer. A proposta não concede
 * autoridade nenhuma — o spawn continua pelo caminho de sempre, e o Main
 * reavalia tudo lá. Por isso este contrato não carrega missão, sessão, conta
 * nem token: ele só descreve "o que eu abriria se a escolha fosse minha".
 */

/**
 * O vocabulário de esforço é o do roteador (`ROUTE_EFFORTS`), não um segundo
 * inventado aqui: `low | medium | high | xhigh`. "A CLI decide" não é um
 * nível — é a AUSÊNCIA de nível, que tira o `--effort` do argv. A interface
 * mostra essa ausência como uma opção; o modelo a guarda como `undefined`.
 */
export type PaneRouteEffort = RouteEffort;
export const PANE_ROUTE_EFFORTS = ROUTE_EFFORTS;

export function isPaneRouteEffort(value: unknown): value is PaneRouteEffort {
  return typeof value === 'string' && (ROUTE_EFFORTS as readonly string[]).includes(value);
}

/** Teto do texto livre aceito do renderer (o classificador já corta antes). */
export const PANE_ROUTE_REQUEST_MAX = 4000;

export const paneRouteRequestSchema = z
  .object({
    /** O que o operador digitou no "+ Pane" (ou o objetivo da missão). */
    request: z.string().min(1).max(PANE_ROUTE_REQUEST_MAX),
    /**
     * CLI que o operador já escolheu na mão. Presente, a proposta respeita a
     * escolha e só preenche o que falta (modelo, esforço, skill) — "agente
     * pedido na mão sempre vence".
     */
    adapterId: z.string().min(1).max(64).optional(),
  })
  .strict();

export type PaneRouteRequest = z.infer<typeof paneRouteRequestSchema>;

/** De onde veio cada campo decidido — o operador vê, não adivinha. */
export type PaneRouteSource = 'jev' | 'heuristic' | 'mixed' | 'operator';

/**
 * A proposta NÃO escolhe a CLI. No "+ Pane" quem escolhe a CLI é o operador,
 * na lista — e escolher a CLI por aqui exigiria o pool de disponibilidade do
 * `routeTaskForCaller` (cota, recusa de credencial, assento de primeira onda)
 * e criaria RESERVA de rota, que é efeito. O que faltava ao pane aberto na
 * mão era o resto: esforço e skill. É isso que esta proposta preenche.
 */
export interface PaneRouteProposal {
  /** Ausente = a CLI decide; o operador pode fixar um nível na interface. */
  readonly effort?: PaneRouteEffort;
  /** Skill sugerida (bundled ou do projeto); ausente = nascer sem skill. */
  readonly skill?: string;
  readonly tier: string;
  readonly specialty?: string;
  /** Frase curta do motor, já sem texto do pedido. */
  readonly reason: string;
  readonly source: PaneRouteSource;
  /** Só das dimensões que o Jev decidiu de fato (0..1, 2 casas). */
  readonly confidence?: {
    readonly tier?: number;
    readonly specialty?: number;
    readonly effort?: number;
    readonly skill?: number;
  };
}

export type PaneRouteResult =
  | { readonly ok: true; readonly proposal: PaneRouteProposal }
  /**
   * Nunca é erro de verdade: sem chave, sem CLI elegível ou com o pedido
   * vazio o "+ Pane" simplesmente segue como sempre foi.
   */
  | { readonly ok: false; readonly reason: 'empty' | 'no-route' | 'disabled' | 'error' };

/**
 * Rótulo curto do esforço para a interface. `none` é "a CLI decide" — e não
 * "nenhum esforço", que leria como desligado.
 */
export function paneRouteEffortLabel(effort: PaneRouteEffort | undefined): string {
  switch (effort) {
    case 'low':
      return 'Baixo';
    case 'medium':
      return 'Médio';
    case 'high':
      return 'Alto';
    case 'xhigh':
      return 'Máximo';
    default:
      return 'A CLI decide';
  }
}

/**
 * Uma linha dizendo por que esta rota saiu, para o chip do passo de confirmação.
 * Sem isso a escolha parece sorteio: o motor já reveza CLIs por fair-share e
 * diversidade, e o operador não tinha como saber disso.
 */
export function paneRouteSummary(proposal: PaneRouteProposal): string {
  const parts = [proposal.tier];
  if (proposal.specialty) parts.push(proposal.specialty);
  const decided =
    proposal.source === 'operator'
      ? 'escolha sua'
      : proposal.source === 'jev'
        ? 'decidido pelo Jev'
        : proposal.source === 'mixed'
          ? 'Jev + regra'
          : 'pela regra';
  return `${parts.join(' · ')} — ${decided}`;
}
