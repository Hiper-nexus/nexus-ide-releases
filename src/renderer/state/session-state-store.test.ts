import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_IDLE_DISPLAY_HOLD_MS,
  __resetSessionStateDisplayTimersForTests,
  useSessionStateStore,
} from './session-state-store';

describe('session-state-store display hysteresis', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSessionStateDisplayTimersForTests();
    useSessionStateStore.setState({
      paneStates: new Map(),
      displayStates: new Map(),
    });
  });

  afterEach(() => {
    __resetSessionStateDisplayTimersForTests();
    vi.useRealTimers();
  });

  it('skips no-op updates (same state does not replace Maps)', () => {
    const store = useSessionStateStore.getState();
    store.setPaneState('p1', 'busy');
    const panes = useSessionStateStore.getState().paneStates;
    const display = useSessionStateStore.getState().displayStates;

    store.setPaneState('p1', 'busy');

    expect(useSessionStateStore.getState().paneStates).toBe(panes);
    expect(useSessionStateStore.getState().displayStates).toBe(display);
  });

  it('applies non-idle states to truth and display immediately', () => {
    const store = useSessionStateStore.getState();
    store.setPaneState('p1', 'spawning');
    store.setPaneState('p1', 'busy');

    expect(useSessionStateStore.getState().paneStates.get('p1')).toBe('busy');
    expect(useSessionStateStore.getState().displayStates.get('p1')).toBe('busy');
  });

  it('holds display on busy while truth goes idle (anti-flicker)', () => {
    const store = useSessionStateStore.getState();
    store.setPaneState('p1', 'busy');
    store.setPaneState('p1', 'idle');

    expect(useSessionStateStore.getState().paneStates.get('p1')).toBe('idle');
    expect(useSessionStateStore.getState().displayStates.get('p1')).toBe('busy');

    vi.advanceTimersByTime(SESSION_IDLE_DISPLAY_HOLD_MS - 1);
    expect(useSessionStateStore.getState().displayStates.get('p1')).toBe('busy');

    vi.advanceTimersByTime(1);
    expect(useSessionStateStore.getState().displayStates.get('p1')).toBe('idle');
  });

  it('sticky display uses previous busy/spawning when display map lacked the pane', () => {
    const store = useSessionStateStore.getState();
    store.setPaneState('p1', 'spawning');
    // Simulate a desynced display (should not happen in prod, but hold must stick).
    useSessionStateStore.setState({
      displayStates: new Map(),
      paneStates: new Map([['p1', 'spawning']]),
    });
    store.setPaneState('p1', 'idle');
    expect(useSessionStateStore.getState().displayStates.get('p1')).toBe('spawning');
  });

  it('cancels idle display hold when work resumes', () => {
    const store = useSessionStateStore.getState();
    store.setPaneState('p1', 'busy');
    store.setPaneState('p1', 'idle');
    vi.advanceTimersByTime(400);
    store.setPaneState('p1', 'busy');

    expect(useSessionStateStore.getState().paneStates.get('p1')).toBe('busy');
    expect(useSessionStateStore.getState().displayStates.get('p1')).toBe('busy');

    vi.advanceTimersByTime(SESSION_IDLE_DISPLAY_HOLD_MS + 100);
    // Stale timer must not force idle after busy resumed.
    expect(useSessionStateStore.getState().displayStates.get('p1')).toBe('busy');
  });

  it('promotes exited immediately even during idle hold', () => {
    const store = useSessionStateStore.getState();
    store.setPaneState('p1', 'busy');
    store.setPaneState('p1', 'idle');
    store.setPaneState('p1', 'exited');

    expect(useSessionStateStore.getState().paneStates.get('p1')).toBe('exited');
    expect(useSessionStateStore.getState().displayStates.get('p1')).toBe('exited');
  });

  it('clears pane and pending timers', () => {
    const store = useSessionStateStore.getState();
    store.setPaneState('p1', 'busy');
    store.setPaneState('p1', 'idle');
    store.clearPaneState('p1');

    expect(useSessionStateStore.getState().paneStates.has('p1')).toBe(false);
    expect(useSessionStateStore.getState().displayStates.has('p1')).toBe(false);

    vi.advanceTimersByTime(SESSION_IDLE_DISPLAY_HOLD_MS + 50);
    expect(useSessionStateStore.getState().displayStates.has('p1')).toBe(false);
  });
});
