// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: duração fixa do DESIGN.md no lugar da configuração do cliente, matchMedia local no lugar de useMediaQuery, tipo de duração local, comentários em PT-BR.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

/** Duração de painel em ms; 0 desliga a animação. */
export type PanelAnimationDurationMs = number;

/**
 * Motion de painel do DESIGN.md (150–220ms, `--ease-out-quart`). É a fonte
 * única: o AppShell repassa este valor ao CSS por `--panel-motion-duration`,
 * então o timeout de desmontagem e a animação nunca divergem.
 */
export const PANEL_ANIMATION_DURATION_MS: PanelAnimationDurationMs = 200;

const PanelAnimationSuppressionContext = createContext(false);

export const PanelAnimationSuppressionProvider =
  PanelAnimationSuppressionContext.Provider;

/**
 * Suprime o motion do painel no primeiro quadro pintado de uma navegação
 * (inicial ou nova). Estado restaurado por navegação aparece na hora; só as
 * ações seguintes do operador animam.
 */
export function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedNavigationKey, setPaintedNavigationKey] = useState<
    string | null
  >(null);
  const suppressed = paintedNavigationKey !== navigationKey;

  useEffect(() => {
    if (!suppressed) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() =>
        setPaintedNavigationKey(navigationKey),
      );
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function reducedMotionQuery(): MediaQueryList | null {
  // matchMedia pode faltar (jsdom, ambientes headless): sem a consulta, motion
  // permitido em vez de quebrar a montagem.
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function readReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    () => false,
  );
}

export function usePanelAnimationSettings(
  durationMs: PanelAnimationDurationMs = PANEL_ANIMATION_DURATION_MS,
): {
  active: boolean;
  durationMs: PanelAnimationDurationMs;
} {
  const prefersReducedMotion = usePrefersReducedMotion();
  const suppressed = useContext(PanelAnimationSuppressionContext);
  return {
    active: durationMs > 0 && !prefersReducedMotion && !suppressed,
    durationMs,
  };
}

/** Mantém montado o conteúdo do painel que fecha até a transição terminar. */
export function usePanelPresence<T>(
  open: boolean,
  value: T | null,
  animated: boolean,
  scopeKey: string | null,
  durationMs: PanelAnimationDurationMs,
): { present: boolean; value: T | null } {
  const [present, setPresent] = useState(open);
  const retainedRef = useRef<{ scopeKey: string | null; value: T | null } | null>(
    open ? { scopeKey, value } : null,
  );

  useEffect(() => {
    if (open) retainedRef.current = { scopeKey, value };
  }, [open, scopeKey, value]);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!animated) {
      setPresent(false);
      return;
    }

    const timeout = window.setTimeout(() => setPresent(false), durationMs);
    return () => window.clearTimeout(timeout);
  }, [animated, durationMs, open]);

  // Escopo novo (outro workspace/checkout ou destino) nunca herda o conteúdo
  // retido do anterior: some no mesmo render, sem esperar o timeout.
  const retainedValue =
    retainedRef.current?.scopeKey === scopeKey ? retainedRef.current.value : null;
  const visible =
    open || (animated && present && retainedRef.current?.scopeKey === scopeKey);
  return { present: visible, value: open ? value : visible ? retainedValue : null };
}
