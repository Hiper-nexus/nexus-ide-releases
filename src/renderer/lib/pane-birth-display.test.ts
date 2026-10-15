import { describe, expect, it } from 'vitest';
import {
  PANE_BIRTH_SLOW_AFTER_MS,
  paneBirthDisplay,
} from './pane-birth-display';

const BASE = {
  sessionState: 'spawning' as const,
  sessionId: null,
  agentName: 'Codex Dev',
  adapterId: 'codex',
  model: 'gpt-5.6-sol',
  elapsedMs: 0,
};

describe('paneBirthDisplay', () => {
  it('names who is coming up while the PTY has no session yet', () => {
    expect(paneBirthDisplay(BASE)).toEqual({
      headline: 'Preparando agente…',
      detail: 'Codex Dev — codex · gpt-5.6-sol',
      slow: false,
    });
  });

  it('stops promising progress once the cold start passes the threshold', () => {
    const display = paneBirthDisplay({
      ...BASE,
      elapsedMs: PANE_BIRTH_SLOW_AFTER_MS,
    });
    expect(display).toMatchObject({ headline: 'A abertura está demorando', slow: true });
    expect(display?.detail).toMatch(/demorando/i);
  });

  it('disappears the moment the real session takes over', () => {
    expect(
      paneBirthDisplay({ ...BASE, sessionId: 'session-1' }),
    ).toBeNull();
    expect(paneBirthDisplay({ ...BASE, sessionState: 'idle' })).toBeNull();
    expect(paneBirthDisplay({ ...BASE, sessionState: 'busy' })).toBeNull();
  });

  it('never claims a dead or hibernated pane is being born', () => {
    expect(paneBirthDisplay({ ...BASE, sessionState: 'exited' })).toBeNull();
    expect(
      paneBirthDisplay({ ...BASE, sessionState: 'hibernated' }),
    ).toBeNull();
  });

  it('covers the pane that has no state at all yet', () => {
    expect(
      paneBirthDisplay({ ...BASE, sessionState: undefined }),
    ).toMatchObject({ headline: 'Preparando agente…' });
  });

  it('falls back to the CLI id when the roster carries no agent name', () => {
    expect(
      paneBirthDisplay({
        ...BASE,
        agentName: undefined,
        model: undefined,
      })?.detail,
    ).toBe('codex');
  });

  it('degrades to a generic identity when nothing is known', () => {
    expect(
      paneBirthDisplay({
        sessionState: 'spawning',
        sessionId: null,
        elapsedMs: 0,
      })?.detail,
    ).toBe('agente');
  });
});
