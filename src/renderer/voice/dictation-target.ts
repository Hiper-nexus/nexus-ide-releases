/**
 * Alvo de ditado em UI (wizard de missão, formulários).
 *
 * O pipeline de ditado nasceu pane-cêntrico: transcreve e injeta no PTY
 * focado. No wizard de missão não há pane — o operador quer falar o OBJETIVO
 * ("às vezes áudio ajuda demais", 19/08). Uma superfície de UI reivindica o
 * alvo enquanto está montada; `routeDictation` consulta o claim ANTES do
 * roteamento de panes e entrega o transcript ao callback.
 *
 * Um claim por vez (último vence — só existe um wizard na tela). O release é
 * idempotente e não derruba claim alheio: liberar um claim antigo depois de
 * outro assumir é um no-op.
 */

export interface DictationTargetClaim {
  readonly id: string;
  readonly onTranscript: (text: string) => void;
}

let activeClaim: DictationTargetClaim | null = null;

export function claimDictationTarget(
  id: string,
  onTranscript: (text: string) => void,
): () => void {
  const claim: DictationTargetClaim = { id, onTranscript };
  activeClaim = claim;
  return () => {
    if (activeClaim === claim) activeClaim = null;
  };
}

export function activeDictationTargetClaim(): DictationTargetClaim | null {
  return activeClaim;
}

export function hasDictationTargetClaim(): boolean {
  return activeClaim !== null;
}

/**
 * Entrega o transcript ao claim ativo. Devolve o pseudo-paneId da entrega ou
 * null quando não há claim (o chamador segue para o roteamento de panes).
 * Callback que lança não derruba o turno de voz — vira falha visível no log
 * do chamador via retorno null? Não: o claim EXISTE, então a entrega é o
 * contrato; um throw aqui é bug da superfície e não pode virar injeção
 * acidental num pane — engolimos e reportamos sucesso do roteamento.
 */
export function deliverDictationToClaim(text: string): { paneId: string } | null {
  if (!activeClaim) return null;
  try {
    activeClaim.onTranscript(text);
  } catch {
    // Superfície quebrada não pode redirecionar fala para um pane oculto.
  }
  return { paneId: `ui:${activeClaim.id}` };
}

/** Test-only. */
export function resetDictationTargetForTests(): void {
  activeClaim = null;
}
