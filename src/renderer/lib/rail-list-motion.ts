// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: FLIP por Web Animations de apps/web/src/components/Sidebar.motion.ts sem o caminho de arrastar (release/dnd-kit), timing do DESIGN.md (180ms, --ease-out-quart, entrada/saída de no máximo 4px), orçamento contando TODO item animado (fades + deslocamentos > 40 desliga), linhas com canvas/xterm nunca animadas nem clonadas, clones sem id/data-*-id/data-action/data-testid, guarda para ambiente sem WAAPI/matchMedia e hook React `useRailListMotion`.
import { useCallback, useLayoutEffect, useRef } from 'react';

/** DESIGN.md §4/§11: 150–220ms com --ease-out-quart (base.css). */
const motionTiming = { duration: 180, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' };
// Rows normally ride their displaced neighbour's travel. Absent a moving
// neighbour, a row enters/leaves with opacity plus a short drift — DESIGN.md
// §11 caps that drift at 4px.
const rowTravel = (height: number) => Math.min(height, 4);
// A filter change or a bulk update swaps a large part of the list at once.
// Every faded row costs a deep clone and every animated row an Animation plus
// forced layout reads, so past this many animated rows the update just snaps.
export const MAX_ANIMATED_ROWS_PER_UPDATE = 40;
/** Canvas (xterm, gráficos) nunca anda nem é clonado: repinta e pisca. */
const NEVER_ANIMATE_SELECTOR = 'canvas, .xterm';

type RowPosition = { top: number; left: number; width: number; height: number };

export interface RailListMotion {
  /** Mede as linhas e, se `animate`, desliza do lugar antigo ao novo. */
  update(animate: boolean): void;
  /** Cancela tudo em curso e esquece a linha de base. */
  suspend(): void;
  /** `suspend` + nunca mais anima esta lista. */
  dispose(): void;
}

function progress(animation: Animation) {
  return animation.playState === 'finished'
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0);
}

/** A clone is a copy of a row React already removed: it must not answer to
 *  ids, test hooks or the rail's own action/id selectors while it fades. */
function isBehaviourAttribute(name: string, element: Element): boolean {
  return (
    (name === 'id' && element.namespaceURI !== 'http://www.w3.org/2000/svg') ||
    name === 'data-testid' ||
    name === 'data-action' ||
    /^data-.*-id$/.test(name)
  );
}

/** Animate rows between their layout positions. The list must be
 * positioned so every direct child's offsetTop has the same origin. */
export function createRailListMotion(parent: HTMLElement): RailListMotion {
  let positions: Map<HTMLElement, RowPosition> | null = null;
  let disposed = false;
  const view = parent.ownerDocument.defaultView;
  const reducedMotion =
    typeof view?.matchMedia === 'function'
      ? view.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  // jsdom e afins: sem WAAPI não há o que animar, só a linha de base.
  const supported = typeof parent.animate === 'function';
  const running = new Map<HTMLElement, { animation: Animation; offset: number }>();
  const entering = new Map<HTMLElement, { animation: Animation; travel: number }>();
  const exiting = new Map<HTMLElement, Animation>();

  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node);
    const run = current ? current.offset * (1 - progress(current.animation)) : 0;
    const entry = entering.get(node);
    const enter = entry ? entry.travel * (1 - progress(entry.animation)) : 0;
    return run + enter;
  };
  const clearFades = () => {
    for (const entry of entering.values()) entry.animation.cancel();
    for (const animation of exiting.values()) animation.cancel();
    for (const node of exiting.keys()) node.remove();
    entering.clear();
    exiting.clear();
  };
  const fadeOut = (node: HTMLElement, position: RowPosition, travel: number) => {
    if (position.height === 0) return;
    // React owns the removed row; only a noninteractive copy stays for the fade.
    const clone = node.cloneNode(true) as HTMLElement;
    for (const element of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of Array.from(element.attributes)) {
        if (isBehaviourAttribute(attribute.name, element)) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    clone.setAttribute('aria-hidden', 'true');
    clone.inert = true;
    Object.assign(clone.style, {
      position: 'absolute',
      top: `${position.top + remainingOffset(node)}px`,
      left: `${position.left}px`,
      width: `${position.width}px`,
      height: `${position.height}px`,
      margin: '0',
      boxSizing: 'border-box',
      contentVisibility: 'visible',
      transform: 'none',
      transition: 'none',
      pointerEvents: 'none',
    });
    parent.append(clone);
    const entry = entering.get(node);
    const entryProgress = entry ? progress(entry.animation) : 1;
    const animation = clone.animate(
      [
        { opacity: entryProgress, transform: 'translateY(0px)' },
        { opacity: 0, transform: `translateY(${travel}px)` },
      ],
      motionTiming,
    );
    exiting.set(clone, animation);
    animation.addEventListener(
      'finish',
      () => {
        clone.remove();
        exiting.delete(clone);
      },
      { once: true },
    );
  };

  const cancel = (node: HTMLElement) => {
    running.get(node)?.animation.cancel();
    running.delete(node);
  };
  const suspend = () => {
    for (const node of running.keys()) cancel(node);
    clearFades();
    positions = null;
  };
  const move = (node: HTMLElement, offset: number) => {
    cancel(node);
    const entry = entering.get(node);
    // The newer transform supersedes entry travel; its original opacity keeps fading.
    if (entry) entry.travel = 0;
    if (offset === 0 && !entry) return;
    const animation = node.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0px)' }],
      motionTiming,
    );
    running.set(node, { animation, offset });
    animation.addEventListener(
      'finish',
      () => {
        if (running.get(node)?.animation === animation) running.delete(node);
      },
      { once: true },
    );
  };

  return {
    update(animate: boolean) {
      if (disposed) return;
      const next = new Map(
        Array.from(parent.children)
          .filter(
            (node): node is HTMLElement =>
              node instanceof HTMLElement &&
              !exiting.has(node) &&
              !node.matches(NEVER_ANIMATE_SELECTOR) &&
              node.querySelector(NEVER_ANIMATE_SELECTOR) === null,
          )
          .map((node) => [
            node,
            {
              top: node.offsetTop,
              left: node.offsetLeft,
              width: node.offsetWidth,
              height: node.offsetHeight,
            },
          ]),
      );
      // Nexus: o orçamento conta todo item que ganharia uma animação — saídas,
      // entradas e deslocados —, não só os fades.
      let animatedCount = 0;
      if (positions !== null) {
        for (const [node, position] of positions) {
          if (!next.has(node) && position.height > 0) animatedCount++;
        }
        for (const [node, position] of next) {
          const previousTop = positions.get(node)?.top;
          if (previousTop === undefined ? position.height > 0 : previousTop !== position.top)
            animatedCount++;
        }
      }
      const shouldAnimate =
        animate &&
        supported &&
        positions !== null &&
        !reducedMotion?.matches &&
        animatedCount <= MAX_ANIMATED_ROWS_PER_UPDATE;
      const movedDelta = new Map<HTMLElement, number>();
      const nextOrder = [...next.keys()];
      const oldOrder = positions === null ? [] : [...positions.keys()];
      const ridingDelta = (
        order: readonly HTMLElement[],
        index: number,
        retained: (node: HTMLElement) => boolean,
      ) => {
        for (let cursor = index - 1; cursor >= 0; cursor--) {
          const node = order[cursor]!;
          const delta = movedDelta.get(node);
          if (delta !== undefined) return delta;
          if (retained(node)) return remainingOffset(node);
        }
        return undefined;
      };
      if (!shouldAnimate) clearFades();
      else {
        // A group that opens above its collapsed anchor shifts every retained
        // row by the same amount. Entering rows take that same displacement so
        // the group arrives as one moving block instead of rows popping into
        // their final slots; exiting rows leave by it.
        for (const [node, position] of next) {
          const previousTop = positions!.get(node)?.top;
          if (previousTop === undefined || previousTop === position.top) continue;
          movedDelta.set(node, previousTop + remainingOffset(node) - position.top);
        }
        for (const [node, position] of positions!) {
          if (next.has(node)) continue;
          const delta = ridingDelta(oldOrder, oldOrder.indexOf(node), (n) => next.has(n));
          fadeOut(node, position, delta === undefined ? rowTravel(position.height) : -delta);
        }
      }
      for (const [node, entry] of entering) {
        if (!next.has(node)) {
          entry.animation.cancel();
          entering.delete(node);
        }
      }
      for (const node of running.keys()) {
        if (!shouldAnimate || !next.has(node)) cancel(node);
      }
      if (shouldAnimate) {
        for (const [index, node] of nextOrder.entries()) {
          const position = next.get(node)!;
          const previousTop = positions!.get(node)?.top;
          if (previousTop === undefined) {
            if (position.height > 0) {
              const delta = ridingDelta(nextOrder, index, (n) => positions!.has(n));
              const travel = delta === undefined ? -rowTravel(position.height) : delta;
              const animation = node.animate(
                [
                  { opacity: 0, transform: `translateY(${travel}px)` },
                  { opacity: 1, transform: 'translateY(0px)' },
                ],
                motionTiming,
              );
              entering.set(node, { animation, travel });
              animation.addEventListener(
                'finish',
                () => {
                  if (entering.get(node)?.animation === animation) entering.delete(node);
                },
                { once: true },
              );
            }
            continue;
          }
          const delta = movedDelta.get(node);
          // Computed progress includes the effect's easing. Only our own
          // translate is carried forward.
          if (delta !== undefined) move(node, delta);
        }
      }
      positions = next;
    },
    suspend,
    dispose() {
      suspend();
      disposed = true;
    },
  };
}

/**
 * Liga o movimento a uma lista da rail. `layoutKey` deve mudar sempre que a
 * ordem, o conjunto ou a altura conhecida das linhas mudar (abrir/recolher):
 * só então a lista anima.
 *
 * ponytail: a linha de base só é medida quando `layoutKey` muda; uma linha que
 * cresce por conteúdo (texto que quebra) sem mudar a chave deixa a base velha
 * e o próximo deslocamento parte de alguns px ao lado. Se incomodar, medir no
 * ResizeObserver da lista.
 */
export function useRailListMotion<T extends HTMLElement>(layoutKey: string) {
  const motionRef = useRef<RailListMotion | null>(null);
  const attach = useCallback((node: T | null) => {
    motionRef.current?.dispose();
    motionRef.current = node === null ? null : createRailListMotion(node);
    motionRef.current?.update(false);
  }, []);
  useLayoutEffect(() => {
    motionRef.current?.update(true);
  }, [layoutKey]);
  return attach;
}
