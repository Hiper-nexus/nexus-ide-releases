import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserDesignEvent } from '../../shared/browser-design';
import {
  clearDesignSession,
  getLastSelection,
  ingestDesignEvent,
  isDesignModeActive,
  onDesignEvent,
  prepareDesignModeTransition,
  resetDesignSessionsForTest,
} from './design-session';

const GENERATION = '6e8a1b53-0f9c-4a2d-9e8f-1a2b3c4d5e6f';
const NEXT_GENERATION = '7f9b2c64-1a0d-4b3e-8f90-2b3c4d5e6f70';

function selectionEvent(over: Partial<BrowserDesignEvent> = {}): BrowserDesignEvent {
  return {
    eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    generation: GENERATION,
    type: 'selection',
    at: 1_700_000_000_000,
    selection: {
      ref: 'e1',
      tag: 'button',
      id: 'save',
      classes: ['btn', 'btn-primary'],
      selector: '#save',
      rect: { x: 12, y: 34, width: 120, height: 40 },
      text: 'Salvar',
      outerHtml: '<button id="save" class="btn btn-primary">Salvar</button>',
      attributes: { id: 'save', class: 'btn btn-primary' },
      computedStyles: { display: 'inline-block', color: 'rgb(255, 255, 255)' },
      url: 'https://example.test/app',
    },
    ...over,
  };
}

function modeEvent(active: boolean): BrowserDesignEvent {
  return {
    eventId: active
      ? '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e60'
      : '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e61',
    generation: GENERATION,
    type: 'mode',
    at: 1_700_000_000_001,
    mode: { active, reason: active ? 'enable' : 'disable' },
  };
}

function activate(paneId = 'pane-a', generation = GENERATION): void {
  prepareDesignModeTransition(paneId, generation, true);
  const event = { ...modeEvent(true), generation };
  expect(ingestDesignEvent(paneId, event).ok).toBe(true);
}

beforeEach(() => {
  activate();
});

afterEach(() => {
  resetDesignSessionsForTest();
});

describe('ingestDesignEvent', () => {
  it('stores a valid selection and returns it for the same pane only', () => {
    const result = ingestDesignEvent('pane-a', selectionEvent());
    expect(result.ok).toBe(true);
    expect(getLastSelection('pane-a')?.ref).toBe('e1');
    expect(getLastSelection('pane-a')?.selector).toBe('#save');
    expect(getLastSelection('pane-b')).toBeNull();
  });

  it('last selection wins', () => {
    ingestDesignEvent('pane-a', selectionEvent());
    const second = selectionEvent();
    second.eventId = '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e61';
    second.selection = { ...second.selection!, ref: 'e2', selector: '#other' };
    ingestDesignEvent('pane-a', second);
    expect(getLastSelection('pane-a')?.ref).toBe('e2');
  });

  it('tracks design mode per pane via mode events', () => {
    resetDesignSessionsForTest();
    expect(isDesignModeActive('pane-a')).toBe(false);
    prepareDesignModeTransition('pane-a', GENERATION, true);
    ingestDesignEvent('pane-a', modeEvent(true));
    expect(isDesignModeActive('pane-a')).toBe(true);
    expect(isDesignModeActive('pane-b')).toBe(false);
    ingestDesignEvent('pane-a', modeEvent(false));
    expect(isDesignModeActive('pane-a')).toBe(false);
  });

  it('rejects malformed envelopes without touching state', () => {
    expect(ingestDesignEvent('pane-a', null).ok).toBe(false);
    expect(ingestDesignEvent('pane-a', { type: 'selection' }).ok).toBe(false);
    expect(
      ingestDesignEvent('pane-a', { ...selectionEvent(), eventId: 'not-a-uuid' }).ok,
    ).toBe(false);
    // type/payload mismatch: selection event without selection body.
    expect(
      ingestDesignEvent('pane-a', { ...selectionEvent(), selection: undefined }).ok,
    ).toBe(false);
    // unknown extra keys are refused (strict contract with the preload).
    expect(
      ingestDesignEvent('pane-a', { ...selectionEvent(), extra: 1 }).ok,
    ).toBe(false);
    expect(getLastSelection('pane-a')).toBeNull();
  });

  it('rejects oversized payloads (caps are part of the contract)', () => {
    const oversized = selectionEvent();
    oversized.selection = {
      ...oversized.selection!,
      outerHtml: 'x'.repeat(5_000),
    };
    expect(ingestDesignEvent('pane-a', oversized).ok).toBe(false);

    const tooManyClasses = selectionEvent();
    tooManyClasses.selection = {
      ...tooManyClasses.selection!,
      classes: Array.from({ length: 40 }, (_, i) => `c${i}`),
    };
    expect(ingestDesignEvent('pane-a', tooManyClasses).ok).toBe(false);
  });

  it('mode off invalidates the stored selection (stale ref)', () => {
    ingestDesignEvent('pane-a', selectionEvent());
    expect(getLastSelection('pane-a')).not.toBeNull();
    ingestDesignEvent('pane-a', modeEvent(false));
    expect(getLastSelection('pane-a')).toBeNull();
  });

  it('rejects a ref outside the automation ref scheme', () => {
    const bad = selectionEvent();
    bad.selection = { ...bad.selection!, ref: 'd1' };
    expect(ingestDesignEvent('pane-a', bad).ok).toBe(false);
  });
});

describe('frameworkHints (L1, VISUAL-EDIT-001 Fase 1)', () => {
  function withHints(hints: unknown): BrowserDesignEvent {
    const event = selectionEvent();
    event.selection = {
      ...event.selection!,
      frameworkHints: hints,
    } as BrowserDesignEvent['selection'];
    return event;
  }

  it('accepts a selection carrying valid react hints (component + owners + prop keys)', () => {
    const result = ingestDesignEvent(
      'pane-a',
      withHints({
        framework: 'react',
        componentName: 'SaveButton',
        ownerChain: ['SaveButton', 'Toolbar', 'App'],
        propKeys: ['label', 'onClick'],
      }),
    );
    expect(result.ok).toBe(true);
    expect(getLastSelection('pane-a')?.frameworkHints?.framework).toBe('react');
    expect(getLastSelection('pane-a')?.frameworkHints?.ownerChain).toEqual([
      'SaveButton',
      'Toolbar',
      'App',
    ]);
  });

  it('accepts svelte hints with a source location (file:line:column)', () => {
    const result = ingestDesignEvent(
      'pane-a',
      withHints({
        framework: 'svelte',
        ownerChain: [],
        source: { file: 'src/routes/+page.svelte', line: 12, column: 4 },
      }),
    );
    expect(result.ok).toBe(true);
    expect(getLastSelection('pane-a')?.frameworkHints?.source?.line).toBe(12);
  });

  it('selection without hints keeps working (L1 is best-effort)', () => {
    expect(ingestDesignEvent('pane-a', selectionEvent()).ok).toBe(true);
    expect(getLastSelection('pane-a')?.frameworkHints).toBeUndefined();
  });

  it('rejects hints beyond contract caps or with unknown shapes', () => {
    // Unknown framework value.
    expect(
      ingestDesignEvent('pane-a', withHints({ framework: 'jquery', ownerChain: [] }))
        .ok,
    ).toBe(false);
    // Owner chain longer than the cap (10).
    expect(
      ingestDesignEvent(
        'pane-a',
        withHints({
          framework: 'react',
          ownerChain: Array.from({ length: 11 }, (_, i) => `C${i}`),
        }),
      ).ok,
    ).toBe(false);
    // Oversized component name.
    expect(
      ingestDesignEvent(
        'pane-a',
        withHints({
          framework: 'react',
          componentName: 'x'.repeat(200),
          ownerChain: [],
        }),
      ).ok,
    ).toBe(false);
    // Extra keys are refused (strict contract).
    expect(
      ingestDesignEvent(
        'pane-a',
        withHints({ framework: 'react', ownerChain: [], props: { a: 1 } }),
      ).ok,
    ).toBe(false);
    // Negative line numbers are refused.
    expect(
      ingestDesignEvent(
        'pane-a',
        withHints({
          framework: 'svelte',
          ownerChain: [],
          source: { file: 'a.svelte', line: -1 },
        }),
      ).ok,
    ).toBe(false);
  });
});

describe('multi-selection (F4 shift+click)', () => {
  function additiveEvent(ref: string, id: string): BrowserDesignEvent {
    const event = selectionEvent();
    event.eventId = `7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4${id}`;
    event.selection = { ...event.selection!, ref, selector: `#${ref}`, additive: true };
    return event;
  }

  it('additive selections accumulate; a plain selection resets to one', async () => {
    const { getSelections } = await import('./design-session');
    ingestDesignEvent('pane-a', selectionEvent());
    expect(getSelections('pane-a')).toHaveLength(1);
    expect(ingestDesignEvent('pane-a', additiveEvent('e2', 'e90')).ok).toBe(true);
    expect(ingestDesignEvent('pane-a', additiveEvent('e3', 'e91')).ok).toBe(true);
    expect(getSelections('pane-a').map((s) => s.ref)).toEqual(['e1', 'e2', 'e3']);
    // lastSelection follows the newest pick.
    expect(getLastSelection('pane-a')?.ref).toBe('e3');
    // A plain (non-additive) click replaces the whole set.
    const plain = selectionEvent();
    plain.eventId = '9b1d4e86-3c4d-4e5f-8012-2c3d4e5f6071';
    ingestDesignEvent('pane-a', plain);
    expect(getSelections('pane-a')).toHaveLength(1);
  });

  it('additive re-pick of the same ref deselects it (toggle)', async () => {
    const { getSelections } = await import('./design-session');
    ingestDesignEvent('pane-a', selectionEvent());
    ingestDesignEvent('pane-a', additiveEvent('e2', 'e92'));
    ingestDesignEvent('pane-a', additiveEvent('e2', 'e93'));
    expect(getSelections('pane-a').map((s) => s.ref)).toEqual(['e1']);
  });

  it('mode off clears the whole set', async () => {
    const { getSelections } = await import('./design-session');
    ingestDesignEvent('pane-a', selectionEvent());
    ingestDesignEvent('pane-a', additiveEvent('e2', 'e94'));
    ingestDesignEvent('pane-a', modeEvent(false));
    expect(getSelections('pane-a')).toEqual([]);
  });
});

describe('reorder events (F3 drag)', () => {
  it('does not notify mutation subscribers unless main armed the generation', () => {
    resetDesignSessionsForTest();
    const mutationSubscriber = vi.fn();
    onDesignEvent(mutationSubscriber);

    const result = ingestDesignEvent('pane-a', {
      eventId: '8a0c3d75-2b3c-4d5e-9f01-1b2c3d4e5f78',
      generation: GENERATION,
      type: 'reorder',
      at: 1_700_000_000_002,
      reorder: {
        nexusId: 'ab12',
        parentNexusId: 'cd34',
        fromIndex: 2,
        toIndex: 0,
      },
    });

    expect(result).toMatchObject({ ok: false, error: 'design mode is not armed' });
    expect(mutationSubscriber).not.toHaveBeenCalled();
  });

  it('accepts a reorder intent and notifies listeners without touching selection state', () => {
    ingestDesignEvent('pane-a', selectionEvent());
    const seen: string[] = [];
    const off = onDesignEvent((_paneId, event) => seen.push(event.type));
    const result = ingestDesignEvent('pane-a', {
      eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e77',
      generation: GENERATION,
      type: 'reorder',
      at: 1_700_000_000_002,
      reorder: { nexusId: 'ab12', parentNexusId: 'cd34', fromIndex: 2, toIndex: 0 },
    });
    off();
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['reorder']);
    expect(getLastSelection('pane-a')?.ref).toBe('e1');
  });

  it('rejects malformed reorder payloads', () => {
    expect(
      ingestDesignEvent('pane-a', {
        eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e78',
        generation: GENERATION,
        type: 'reorder',
        at: 1,
        reorder: { nexusId: 'a', parentNexusId: 'b', fromIndex: -1, toIndex: 0 },
      }).ok,
    ).toBe(false);
  });

  it('consumes each reorder event id once so replay causes zero second effect', () => {
    const listener = vi.fn();
    onDesignEvent(listener);
    const reorder: BrowserDesignEvent = {
      eventId: '8a0c3d75-2b3c-4d5e-9f01-1b2c3d4e5f79',
      generation: GENERATION,
      type: 'reorder',
      at: 1_700_000_000_003,
      reorder: {
        nexusId: 'ab12',
        parentNexusId: 'cd34',
        fromIndex: 2,
        toIndex: 0,
      },
    };

    expect(ingestDesignEvent('pane-a', reorder).ok).toBe(true);
    expect(ingestDesignEvent('pane-a', reorder)).toMatchObject({
      ok: false,
      error: 'duplicate design event',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects stale generation events after a new enable transition is armed', () => {
    const listener = vi.fn();
    onDesignEvent(listener);
    prepareDesignModeTransition('pane-a', NEXT_GENERATION, true);

    const stale = selectionEvent();
    expect(ingestDesignEvent('pane-a', stale)).toMatchObject({
      ok: false,
      error: 'stale design generation',
    });
    expect(listener).not.toHaveBeenCalled();
    expect(getLastSelection('pane-a')).toBeNull();
  });
});

describe('onDesignEvent', () => {
  it('notifies subscribers with paneId and the validated event', () => {
    const seen: Array<{ paneId: string; type: string }> = [];
    const off = onDesignEvent((paneId, event) => {
      seen.push({ paneId, type: event.type });
    });
    ingestDesignEvent('pane-a', selectionEvent());
    ingestDesignEvent('pane-a', { garbage: true });
    off();
    ingestDesignEvent('pane-a', modeEvent(true));
    expect(seen).toEqual([{ paneId: 'pane-a', type: 'selection' }]);
  });

  it('a throwing listener does not break ingestion or other listeners', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    onDesignEvent(bad);
    onDesignEvent(good);
    const result = ingestDesignEvent('pane-a', selectionEvent());
    expect(result.ok).toBe(true);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('clearDesignSession', () => {
  it('drops selection and mode state for the pane', () => {
    ingestDesignEvent('pane-a', selectionEvent());
    ingestDesignEvent('pane-a', modeEvent(true));
    clearDesignSession('pane-a');
    expect(getLastSelection('pane-a')).toBeNull();
    expect(isDesignModeActive('pane-a')).toBe(false);
  });
});
