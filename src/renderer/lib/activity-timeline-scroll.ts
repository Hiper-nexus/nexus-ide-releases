// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só as decisões de
// scroll que a timeline de atividade usa, tiradas de MessagesTimeline.tsx
// (opções de maintainScrollAtEnd, suspensão do follow ao abrir/fechar um
// detalhe, MVCP data+size); sem composer, citação, minimapa nem memória de
// posição por thread — a timeline do Nexus abre no topo, como antes.
// markListWrappersPresentational é do Nexus (acessibilidade da lista virtual).
import type {
  MaintainScrollAtEndOptions,
  MaintainVisibleContentPositionConfig,
} from '@legendapp/list/react';

/**
 * Trocar de missão ou de filtro troca a `key` da lista: o Legend remonta com
 * estado novo e nenhuma âncora, follow ou offset do escopo anterior sobrevive.
 */
export function createActivityScopeKey(missionId: string, filter: string): string {
  return `${missionId}::${filter}`;
}

/**
 * Banda do "já está no fim", na unidade do `maintainScrollAtEndThreshold` do
 * Legend: FRAÇÃO da altura da viewport, não pixels (1 seria uma tela inteira).
 * 0.08 de uma lista de 480 px são ~38 px — a banda de re-arme de 40 px do
 * upstream e menos que um card fechado (48 px medidos no Chromium). Rolou para
 * cima mais que isso: o stream não puxa a lista.
 */
export const ACTIVITY_TIMELINE_FOLLOW_THRESHOLD = 0.08;

const MAINTAIN_SCROLL_AT_END_INSTANT = {
  animated: false,
} as const satisfies MaintainScrollAtEndOptions;

const MAINTAIN_SCROLL_AT_END_SMOOTH = {
  animated: true,
} as const satisfies MaintainScrollAtEndOptions;

/**
 * Follow do fim. Enquanto um detalhe abre/fecha, o follow fica desligado: senão
 * o gatilho de layout do item puxaria a lista para o fim e o card clicado
 * pularia para cima. Com movimento reduzido, o follow não anima.
 */
export function resolveMaintainScrollAtEnd(input: {
  readonly disclosureSettling: boolean;
  readonly reducedMotion: boolean;
}): false | MaintainScrollAtEndOptions {
  if (input.disclosureSettling) return false;
  return input.reducedMotion ? MAINTAIN_SCROLL_AT_END_INSTANT : MAINTAIN_SCROLL_AT_END_SMOOTH;
}

/**
 * MVCP: `size` mantém o conteúdo visível parado quando uma linha ACIMA muda de
 * altura (detalhe expandido); `data` faz o mesmo quando eventos entram fora de
 * ordem acima da viewport.
 */
export const ACTIVITY_TIMELINE_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: true,
  size: true,
} as const satisfies MaintainVisibleContentPositionConfig;

/**
 * O Legend envolve cada linha em divs próprias (camada e contêiner posicionado)
 * e o Chromium as expõe como `generic` entre o role=list e cada role=listitem:
 * a lista deixa de possuir os itens na árvore de acessibilidade. Marca essas
 * divs como apresentação (role="none"), do item até a lista. Fora de uma lista
 * ou em quem já declara role, não toca em nada.
 */
export function markListWrappersPresentational(item: Element | null): void {
  if (!item) return;
  const wrappers: Element[] = [];
  for (let el = item.parentElement; el && wrappers.length <= 8; el = el.parentElement) {
    if (el.getAttribute('role') === 'list') {
      for (const wrapper of wrappers) {
        if (!wrapper.hasAttribute('role')) wrapper.setAttribute('role', 'none');
      }
      return;
    }
    wrappers.push(el);
  }
}

type FrameScheduler = {
  readonly request: (callback: FrameRequestCallback) => number;
  readonly cancel: (handle: number) => void;
};

const browserFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Dois frames cobrem a medição da linha que mudou de altura e o ajuste de
 * posição do Legend. Devolve o cancelamento (desmontagem ou novo clique).
 */
export function scheduleDisclosureSettle(
  onSettled: () => void,
  frames: FrameScheduler = browserFrames,
): () => void {
  let second: number | null = null;
  const first = frames.request(() => {
    second = frames.request(() => {
      second = null;
      onSettled();
    });
  });
  return () => {
    frames.cancel(first);
    if (second !== null) frames.cancel(second);
  };
}
