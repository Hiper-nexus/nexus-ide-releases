/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductFlagResolutionRow } from '../../../shared/product-api';
import { BUILTIN_FEATURE_FLAGS } from '../../../shared/feature-flags';
import { describeFlagReason, LABS_FLAG_COPY, LabsSection } from './LabsSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function row(
  id: string,
  enabled: boolean,
  reason: string,
  definition: unknown = {},
): ProductFlagResolutionRow {
  return { id, enabled, reason, definition };
}

function installNexus(rows: ProductFlagResolutionRow[]): {
  setOverride: ReturnType<typeof vi.fn>;
} {
  const setOverride = vi.fn(
    async (input: { id: string; enabled: boolean | null }) =>
      rows.map((r) =>
        r.id === input.id
          ? {
              ...r,
              enabled: input.enabled ?? r.enabled,
              reason: input.enabled === null ? 'default' : 'override',
            }
          : r,
      ),
  );
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      product: {
        flagsList: vi.fn(async () => rows),
        flagsSetOverride: setOverride,
        onFlagsChanged: vi.fn(() => () => {}),
      },
    },
  });
  return { setOverride };
}

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<LabsSection />));
  return { host, root };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('LabsSection', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders every flag with its resolved state', async () => {
    installNexus([
      row('feature.search.mixer', true, 'default'),
      row('feature.mcp.hub', false, 'default'),
    ]);
    const { host } = mount();
    await flushEffects();

    const rows = host.querySelectorAll('[data-flag-id]');
    expect(rows).toHaveLength(2);
    const switches = host.querySelectorAll('[role="switch"]');
    expect(switches[0]?.getAttribute('aria-checked')).toBe('true');
    expect(switches[1]?.getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain('padrão do app');
  });

  it('toggles a flag via flagsSetOverride and reflects the returned list', async () => {
    const { setOverride } = installNexus([
      row('feature.mcp.hub', false, 'default'),
    ]);
    const { host } = mount();
    await flushEffects();

    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      toggle?.click();
    });
    await flushEffects();

    expect(setOverride).toHaveBeenCalledWith({
      id: 'feature.mcp.hub',
      enabled: true,
    });
    expect(
      host.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(host.textContent).toContain('escolha personalizada');
  });

  it('offers "Restaurar padrão" only for overrides and clears with null', async () => {
    const { setOverride } = installNexus([
      row('feature.search.mixer', false, 'override'),
      row('feature.mcp.hub', false, 'default'),
    ]);
    const { host } = mount();
    await flushEffects();

    const resets = host.querySelectorAll<HTMLButtonElement>('.labs-flag__reset');
    expect(resets).toHaveLength(1);
    await act(async () => {
      resets[0]?.click();
    });
    await flushEffects();

    expect(setOverride).toHaveBeenCalledWith({
      id: 'feature.search.mixer',
      enabled: null,
    });
  });

  it('disables the switch when the definition carries a kill switch', async () => {
    installNexus([
      row('feature.search.mixer', false, 'kill-switch', { killSwitch: true }),
    ]);
    const { host } = mount();
    await flushEffects();

    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.disabled).toBe(true);
    expect(host.textContent).toContain('desativado pelo sistema');
  });
});

describe('describeFlagReason', () => {
  it('translates every known resolution reason', () => {
    expect(describeFlagReason('default')).toBe('padrão do app');
    expect(describeFlagReason('override')).toBe('escolha personalizada');
    expect(describeFlagReason('kill-switch')).toBe('desativado pelo sistema');
    expect(describeFlagReason('channel-blocked')).toBe('indisponível nesta versão');
    expect(describeFlagReason('unknown-flag')).toBe('unknown-flag');
  });
});


it('gives every built-in experimental resource a readable label and explanation', () => {
  for (const flag of BUILTIN_FEATURE_FLAGS) {
    expect(LABS_FLAG_COPY[flag.id]?.title).toBeTruthy();
    expect(LABS_FLAG_COPY[flag.id]?.hint).toBeTruthy();
  }
});
