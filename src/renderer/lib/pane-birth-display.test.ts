import { describe, expect, it } from 'vitest';
import {
  PANE_BIRTH_FAILED_AFTER_MS,
  PANE_BIRTH_SLOW_AFTER_MS,
  paneBirthDisplay,
  paneBirthFailureReason,
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
      failed: false,
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

describe('paneBirthFailureReason', () => {
  it('names the Grok login cause categorically', () => {
    expect(
      paneBirthFailureReason(
        'A sessão do Grok expirou: a última renovação tem mais de 7 dias e o Grok não renova mais. Faça login uma vez — use "Entrar" no cartão do Grok na lista Atenção',
      ),
    ).toBe('Grok precisa de login');
  });

  it('never echoes the raw error, argv or a secret-looking value', () => {
    const raw =
      'spawn failed: grok --model grok-4.7 XAI_API_KEY=xai-1234567890abcdef';
    const reason = paneBirthFailureReason(raw);
    expect(reason).not.toContain('xai-');
    expect(reason).not.toContain('--model');
    expect(reason).not.toContain('spawn failed');
  });

  it('falls back to a generic sentence for an unknown refusal', () => {
    expect(paneBirthFailureReason('invalid spawn request (model: required)')).toBe(
      'O agente não subiu',
    );
  });
});

describe('paneBirthDisplay — estado de falha', () => {
  it('reports the categorical reason when the Main refused the spawn', () => {
    const display = paneBirthDisplay({
      ...BASE,
      failureReason: 'A sessão do Grok expirou: rode `grok login`',
    });
    expect(display).toMatchObject({
      headline: 'Não subiu',
      failed: true,
      slow: false,
    });
    expect(display?.detail).toBe('Grok precisa de login');
  });

  it('stops promising progress once the hard deadline passes with no session', () => {
    // Buraco real: o RPC que nunca resolve e o waitForSpawnAccess falso
    // deixavam o card em "Ainda subindo…" para sempre.
    const display = paneBirthDisplay({
      ...BASE,
      elapsedMs: PANE_BIRTH_FAILED_AFTER_MS,
    });
    expect(display).toMatchObject({ failed: true, headline: 'Não subiu' });
    expect(display?.detail).toMatch(/prazo/);
  });

  it('keeps the slow state below the failure deadline', () => {
    expect(
      paneBirthDisplay({ ...BASE, elapsedMs: PANE_BIRTH_SLOW_AFTER_MS }),
    ).toMatchObject({ slow: true, failed: false });
  });

  it('still disappears once the real session takes over, failure or not', () => {
    expect(
      paneBirthDisplay({
        ...BASE,
        sessionId: 'session-1',
        failureReason: 'A sessão do Grok expirou',
      }),
    ).toBeNull();
  });

  it('a refusal survives the exited state instead of leaving a black rectangle', () => {
    // O Main recusa e o terminal-host marca `exited`: antes o overlay saía da
    // árvore e o operador ficava com um terminal vazio sem explicação.
    expect(
      paneBirthDisplay({
        ...BASE,
        sessionState: 'exited',
        failureReason: 'A sessão do Grok expirou: rode `grok login`',
      }),
    ).toMatchObject({ failed: true, detail: 'Grok precisa de login' });
  });

  it('never claims a hibernated pane failed to come up', () => {
    expect(
      paneBirthDisplay({
        ...BASE,
        sessionState: 'hibernated',
        failureReason: 'A sessão do Grok expirou',
      }),
    ).toBeNull();
  });
});
