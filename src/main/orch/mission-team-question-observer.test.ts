import { describe, expect, it } from 'vitest';
import {
  extractObserverPaneSessions,
  loadObserverPaneSessions,
} from './mission-team-question-observer';
import { selectObserverPaneSession } from './mission-team-question-completion';
import { testProjectScope } from './__tests__/scope-fixture';

describe('extractObserverPaneSessions', () => {
  it('keeps only well-formed pane/session pairs in order', () => {
    expect(extractObserverPaneSessions([
      JSON.stringify({ frameSeq: 1, sessionId: 'pty-1', paneId: 'pane-1', observer: {} }),
      { sessionId: 'pty-2', paneId: 'pane-2' },
      JSON.stringify({ sessionId: 'pty-3' }),
      JSON.stringify({ paneId: 'pane-4' }),
      JSON.stringify({ sessionId: '', paneId: 'pane-5' }),
      'not-json{{{',
      null,
      42,
      JSON.stringify({ sessionId: 'pty-6', paneId: 'pane-1' }),
    ])).toEqual([
      { paneId: 'pane-1', sessionId: 'pty-1' },
      { paneId: 'pane-2', sessionId: 'pty-2' },
      { paneId: 'pane-1', sessionId: 'pty-6' },
    ]);
  });
});

describe('selectObserverPaneSession', () => {
  it('returns the latest binding for a pane and null when absent', () => {
    const bindings = [
      { paneId: 'pane-a', sessionId: 'pty-old' },
      { paneId: 'pane-b', sessionId: 'pty-b' },
      { paneId: 'pane-a', sessionId: 'pty-new' },
    ];
    expect(selectObserverPaneSession(bindings, 'pane-a')).toBe('pty-new');
    expect(selectObserverPaneSession(bindings, 'pane-b')).toBe('pty-b');
    expect(selectObserverPaneSession(bindings, 'pane-missing')).toBeNull();
    expect(selectObserverPaneSession(undefined, 'pane-a')).toBeNull();
  });
});

describe('loadObserverPaneSessions', () => {
  it('honors injected payloads without touching the journal', () => {
    expect(loadObserverPaneSessions(testProjectScope(), 'mission-x', {
      listSpawnPayloads: () => [JSON.stringify({ sessionId: 'pty-1', paneId: 'pane-1' })],
    })).toEqual([{ paneId: 'pane-1', sessionId: 'pty-1' }]);
  });

  it('fail-closes to an empty list when the source throws', () => {
    expect(loadObserverPaneSessions(testProjectScope(), 'mission-x', {
      listSpawnPayloads: () => { throw new Error('journal offline'); },
    })).toEqual([]);
    expect(loadObserverPaneSessions(testProjectScope(), '')).toEqual([]);
  });
});
