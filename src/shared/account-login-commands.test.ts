import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_LOGIN_COMMANDS,
  accountLoginCommandFor,
} from './account-login-commands';

describe('account login commands', () => {
  it('covers every session-login adapter with its own command', () => {
    // Snapshot-capable adapters plus terminal-login-only OpenClaude/Muse.
    expect(Object.keys(ACCOUNT_LOGIN_COMMANDS).sort()).toEqual([
      'agy',
      'claude',
      'codex',
      'devin',
      'grok',
      'kimi',
      'mimo-code',
      'muse',
      'openclaude',
      'opencode',
    ]);
    for (const command of Object.values(ACCOUNT_LOGIN_COMMANDS)) {
      expect(command.trim().length).toBeGreaterThan(0);
      // Uma linha de shell simples — sem metacaracteres que mudem o comando.
      expect(command).not.toMatch(/[;&|<>$`\\\n\r]/);
    }
  });

  it('returns null for token-based adapters (GLM/LongCat) and unknowns', () => {
    expect(accountLoginCommandFor('glm')).toBeNull();
    expect(accountLoginCommandFor('glm-flash')).toBeNull();
    expect(accountLoginCommandFor('longcat')).toBeNull();
    expect(accountLoginCommandFor('desconhecido')).toBeNull();
  });

  it('claude login uses the dedicated auth subcommand', () => {
    expect(accountLoginCommandFor('claude')).toBe('claude auth login');
  });

  it('openclaude login uses its own auth subcommand, not claude', () => {
    expect(accountLoginCommandFor('openclaude')).toBe('openclaude auth login');
  });
});
