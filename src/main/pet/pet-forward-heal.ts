/**
 * Self-heal do click-through do companion (Bug 7 — “de vidro”).
 *
 * O protocolo normal de interatividade depende por inteiro do forward do
 * `setIgnoreMouseEvents(true, { forward: true })`: é o mousemove encaminhado
 * que alimenta o hit-test do renderer (`elementFromPoint`) e dispara
 * `setInteractive(true)`. Quando o AppKit perde o flag (show/moveTop/troca de
 * Space), NENHUM evento chega ao renderer — o hit-test nunca roda, o IPC
 * nunca é enviado e o pet fica visível mas permanentemente não clicável. Os
 * re-applies com force existentes cobrem os caminhos de código conhecidos;
 * este módulo cobre o resto: o main já faz poll do cursor do SO a cada tick
 * do look loop, então ele pode notar “um humano está apontando para a janela
 * em modo click-through” e (a) re-aplicar o ignore com force para reviver o
 * forward e (b) sondar o renderer com as coords do cursor — o que também
 * cura o cursor PARADO sobre o sprite (sem movimento não há mousemove, mesmo
 * com forward vivo).
 */

export interface ForwardHealOptions {
  /** Ticks consecutivos com o cursor dentro dos bounds para reviver. */
  reviveAfterTicks: number;
  /** Intervalo mínimo entre revives (ms) — não recompõe a superfície em spam. */
  minReviveIntervalMs: number;
  /** Injetável para testes. */
  now?: () => number;
}

export interface ForwardHealInput {
  /** Cursor do SO dentro dos bounds da janela do pet. */
  cursorInside: boolean;
  /** Janela está em modo click-through (cache petIgnoresMouse=true)? */
  ignoresMouse: boolean;
  /** Arrasto em curso: a janela já está interativa, nada a curar. */
  dragging: boolean;
  windowVisible: boolean;
}

export interface ForwardHealDecision {
  /** Re-aplicar setIgnoreMouseEvents(true, { forward: true }) com force. */
  revive: boolean;
  /** Sondar o renderer com as coords do cursor (hit-test no lado de lá). */
  probe: boolean;
}

export interface ForwardHealTracker {
  observe(input: ForwardHealInput): ForwardHealDecision;
  reset(): void;
}

/** Cursor (DIP, screen) dentro do retângulo (DIP, screen)? */
export function cursorInsideBounds(
  cursor: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    cursor.x >= bounds.x &&
    cursor.x <= bounds.x + bounds.width &&
    cursor.y >= bounds.y &&
    cursor.y <= bounds.y + bounds.height
  );
}

export function createForwardHealTracker(
  options: ForwardHealOptions,
): ForwardHealTracker {
  const now = options.now ?? Date.now;
  let insideTicks = 0;
  let wasInside = false;
  // -Infinity: o PRIMEIRO revive nunca é throttled (âncora em 0 travaria
  // relógios de teste iniciando no epoch).
  let lastReviveAt = -Infinity;

  return {
    observe(input: ForwardHealInput): ForwardHealDecision {
      const eligible =
        input.windowVisible && !input.dragging && input.ignoresMouse;
      const inside = eligible && input.cursorInside;

      // Sonda na transição fora→dentro: substitui o mouseenter que o
      // click-through deveria ter entregado (cursor parado sobre o sprite).
      const probe = inside && !wasInside;
      wasInside = inside;

      if (!inside) {
        insideTicks = 0;
        return { revive: false, probe };
      }
      insideTicks += 1;

      if (insideTicks < options.reviveAfterTicks) {
        return { revive: false, probe };
      }
      const t = now();
      if (t - lastReviveAt < options.minReviveIntervalMs) {
        return { revive: false, probe };
      }
      lastReviveAt = t;
      // O contador NÃO zera: se o revive não colou, a próxima janela de
      // minReviveIntervalMs tenta de novo enquanto o cursor continuar lá.
      return { revive: true, probe: true };
    },
    reset(): void {
      insideTicks = 0;
      wasInside = false;
      lastReviveAt = -Infinity;
    },
  };
}
