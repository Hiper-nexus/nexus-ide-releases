// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: vitest + jsdom com react-dom/client no lugar de react-test-renderer, casos de usePanelPresence (saída, reabertura, escopo, reduced-motion) acrescentados.
/** @vitest-environment jsdom */
import { act, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PANEL_ANIMATION_DURATION_MS,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
  usePanelPresence,
} from './panel-presence';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let pendingFrames: FrameRequestCallback[] = [];
let observed: boolean[] = [];

function SuppressionProbe({ navigationKey }: { navigationKey: string }) {
  const suppressed = usePanelNavigationSuppression(navigationKey);
  useLayoutEffect(() => {
    observed.push(suppressed);
  }, [suppressed]);
  return null;
}

interface PresenceProbeProps {
  open: boolean;
  value: string | null;
  scopeKey: string | null;
  animated?: boolean;
}

/** Sem `animated`, decide como o AppShell: duração do DESIGN.md + reduced-motion. */
function PresenceProbe({ open, value, scopeKey, animated }: PresenceProbeProps) {
  const settings = usePanelAnimationSettings();
  const presence = usePanelPresence(
    open,
    value,
    animated ?? settings.active,
    scopeKey,
    settings.durationMs,
  );
  return presence.present ? (
    <output data-testid="panel">{presence.value}</output>
  ) : null;
}

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

function rerender(node: ReactNode): void {
  act(() => root?.render(node));
}

function panelText(host: HTMLElement): string | null {
  return host.querySelector('[data-testid="panel"]')?.textContent ?? null;
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  pendingFrames = [];
  observed = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function paintPendingFrame(): void {
  const callback = pendingFrames.shift();
  act(() => callback?.(0));
}

describe('usePanelNavigationSuppression', () => {
  it('suppresses initial and navigated panel state until each route has painted', () => {
    render(<SuppressionProbe navigationKey="/workspace/one" />);
    expect(observed.at(-1)).toBe(true);

    paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    paintPendingFrame();
    expect(observed.at(-1)).toBe(false);

    rerender(<SuppressionProbe navigationKey="/workspace/two" />);
    expect(observed.at(-1)).toBe(true);

    paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    paintPendingFrame();
    expect(observed.at(-1)).toBe(false);
  });
});

describe('usePanelPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('keeps the closing content mounted for exactly the panel duration', () => {
    const host = render(
      <PresenceProbe open value="Git do ws-a" scopeKey="ws-a" animated />,
    );
    rerender(<PresenceProbe open={false} value={null} scopeKey="ws-a" animated />);

    expect(panelText(host)).toBe('Git do ws-a');
    act(() => vi.advanceTimersByTime(PANEL_ANIMATION_DURATION_MS - 1));
    expect(panelText(host)).toBe('Git do ws-a');
    act(() => vi.advanceTimersByTime(1));
    expect(panelText(host)).toBeNull();
  });

  it('cancels the pending removal when the panel reopens mid-exit', () => {
    const host = render(
      <PresenceProbe open value="primeiro" scopeKey="ws-a" animated />,
    );
    rerender(<PresenceProbe open={false} value={null} scopeKey="ws-a" animated />);
    act(() => vi.advanceTimersByTime(PANEL_ANIMATION_DURATION_MS / 2));

    rerender(<PresenceProbe open value="reaberto" scopeKey="ws-a" animated />);
    act(() => vi.advanceTimersByTime(PANEL_ANIMATION_DURATION_MS * 3));

    expect(panelText(host)).toBe('reaberto');
  });

  it('never shows the previous scope content in a new workspace or destination', () => {
    const host = render(
      <PresenceProbe open value="painel do ws-a" scopeKey="ws-a" animated />,
    );

    rerender(<PresenceProbe open={false} value={null} scopeKey="ws-b" animated />);
    expect(panelText(host)).toBeNull();

    rerender(<PresenceProbe open value="painel do ws-b" scopeKey="ws-b" animated />);
    expect(panelText(host)).toBe('painel do ws-b');
  });

  it('removes at once under prefers-reduced-motion', () => {
    stubReducedMotion(true);
    const host = render(
      <PresenceProbe open value="painel" scopeKey="ws-a" />,
    );
    // Sem supressão de navegação aqui: só o reduced-motion decide.
    rerender(<PresenceProbe open={false} value={null} scopeKey="ws-a" />);

    expect(panelText(host)).toBeNull();
  });

  it('animates the same close when motion is allowed', () => {
    stubReducedMotion(false);
    const host = render(
      <PresenceProbe open value="painel" scopeKey="ws-a" />,
    );
    rerender(<PresenceProbe open={false} value={null} scopeKey="ws-a" />);

    expect(panelText(host)).toBe('painel');
  });
});
