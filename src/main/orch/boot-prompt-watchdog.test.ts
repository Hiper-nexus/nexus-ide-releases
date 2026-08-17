import { describe, expect, it } from 'vitest';
import {
  BOOT_PROMPT_MAX_AGE_MS,
  BOOT_PROMPT_MAX_ATTEMPTS,
  createBootPromptWatchdog,
  matchBootPrompt,
} from './boot-prompt-watchdog';

describe('matchBootPrompt (padrões de confirmação de boot)', () => {
  it('casa folder-trust do Kimi e press-enter genéricos', () => {
    expect(matchBootPrompt('Do you trust the files in this folder?')).toBeTruthy();
    expect(matchBootPrompt('Trust this folder? [y/N]')).toBeTruthy();
    expect(matchBootPrompt('Press Enter to continue')).toBeTruthy();
    expect(matchBootPrompt('Press enter to accept and continue')).toBeTruthy();
    expect(matchBootPrompt('Allow telemetry? (yes/no)')).toBeTruthy();
  });

  it('NÃO casa saída comum de agente trabalhando', () => {
    expect(matchBootPrompt('Running tests... 42 passed')).toBeNull();
    expect(matchBootPrompt('edit src/main.ts to fix the folder scan')).toBeNull();
    expect(matchBootPrompt('')).toBeNull();
  });

  it('ignora ANSI residual no tail', () => {
    expect(matchBootPrompt('\x1b[1mDo you trust the files in this folder?\x1b[0m')).toBeTruthy();
  });
});

describe('createBootPromptWatchdog (aperta Enter sozinho em pane de missão)', () => {
  function harness(tails: Record<string, string>) {
    const writes: Array<{ sessionId: string; data: string }> = [];
    let clock = 1_000;
    const wd = createBootPromptWatchdog({
      now: () => clock,
      readTail: (sessionId) => tails[sessionId] ?? '',
      write: (sessionId, data) => {
        writes.push({ sessionId, data });
        return true;
      },
    });
    return { wd, writes, advance: (ms: number) => { clock += ms; } };
  }

  it('envia Enter após 2 ticks estáveis e limpa quando o prompt some', () => {
    const tails: Record<string, string> = {
      's-kimi': 'Do you trust the files in this folder?',
    };
    const h = harness(tails);
    h.wd.trackSession('s-kimi', 'pane-1', 'kimi', 'mission-1');

    h.wd.tick(); // 1ª janela
    expect(h.writes).toHaveLength(0);
    h.advance(4_000);
    h.wd.tick(); // 2ª janela estável → Enter
    expect(h.writes).toEqual([{ sessionId: 's-kimi', data: '\r' }]);

    tails['s-kimi'] = 'Kimi Code — ready'; // prompt aceito
    h.advance(4_000);
    h.wd.tick();
    expect(h.writes).toHaveLength(1);
  });

  it('não passa do máximo de tentativas (pane que insiste no prompt)', () => {
    const tails = { 's-x': 'Press Enter to continue' };
    const h = harness(tails);
    h.wd.trackSession('s-x', 'pane-2', 'codex', 'mission-1');
    for (let i = 0; i < BOOT_PROMPT_MAX_ATTEMPTS + 4; i += 1) {
      h.wd.tick();
      h.advance(4_000);
    }
    expect(h.writes).toHaveLength(BOOT_PROMPT_MAX_ATTEMPTS);
  });

  it('igna prompt em sessão SEM missão (pane do operador é do operador)', () => {
    const tails = { 's-user': 'Do you trust the files in this folder?' };
    const h = harness(tails);
    h.wd.trackSession('s-user', 'pane-3', 'kimi', undefined);
    h.wd.tick();
    h.advance(4_000);
    h.wd.tick();
    h.advance(4_000);
    h.wd.tick();
    expect(h.writes).toHaveLength(0);
  });

  it('desiste depois da janela de boot (prompt tardio não é de boot)', () => {
    const tails = { 's-old': 'Press Enter to continue' };
    const h = harness(tails);
    h.wd.trackSession('s-old', 'pane-4', 'kimi', 'mission-1');
    h.advance(BOOT_PROMPT_MAX_AGE_MS + 1_000);
    h.wd.tick();
    h.advance(4_000);
    h.wd.tick();
    expect(h.writes).toHaveLength(0);
  });

  it('prompt instável (sumiu e voltou) não dispara imediatamente', () => {
    const tails: Record<string, string> = { 's-flicker': '' };
    const h = harness(tails);
    h.wd.trackSession('s-flicker', 'pane-5', 'kimi', 'mission-1');
    h.wd.tick(); // sem prompt
    h.advance(4_000);
    tails['s-flicker'] = 'Press Enter to continue';
    h.wd.tick(); // 1ª janela com prompt
    expect(h.writes).toHaveLength(0);
  });
});
