import { describe, expect, it } from 'vitest';
import {
  WINDOWS_COMMAND_LINE_SAFE_LIMIT,
  quoteWindowsArg,
  windowsArgvPromptPlacement,
  windowsCommandLineLength,
} from './windows-command-line';

describe('linha de comando do Windows (F-670/F-671)', () => {
  it('cita como o MSVCRT: espaço, aspas e barras antes de aspas', () => {
    expect(quoteWindowsArg('simples')).toBe('simples');
    expect(quoteWindowsArg('')).toBe('""');
    expect(quoteWindowsArg('com espaço')).toBe('"com espaço"');
    expect(quoteWindowsArg('diz "oi"')).toBe('"diz \\"oi\\""');
    expect(quoteWindowsArg('C:\\pasta com espaço\\')).toBe('"C:\\pasta com espaço\\\\"');
    expect(quoteWindowsArg('linha 1\nlinha 2')).toBe('"linha 1\nlinha 2"');
    expect(windowsCommandLineLength('a.exe', ['b c'])).toBe('a.exe "b c"'.length);
  });

  const brief = '## Nexus execution authority\nexecutionMode=same_checkout\nFaça a tarefa.';

  it('launcher .cmd/.bat nunca leva o brief: sai do argv (F-670)', () => {
    const placement = windowsArgvPromptPlacement({
      file: 'C:\\npm\\claude.cmd',
      args: ['--model', 'opus', brief],
      prompt: brief,
      channel: { kind: 'positional' },
    });
    expect(placement).toEqual({ defer: true, reason: 'batch-launcher', args: ['--model', 'opus'] });
  });

  it('executável direto com linha curta mantém o brief', () => {
    expect(windowsArgvPromptPlacement({
      file: 'C:\\npm\\node_modules\\claude.exe',
      args: ['--model', 'opus', brief],
      prompt: brief,
      channel: { kind: 'positional' },
    })).toEqual({ defer: false });
  });

  it('mede a linha INTEIRA: brief abaixo de 20K com 13K de config estoura (F-671)', () => {
    const big = 'x'.repeat(19_900);
    const hooks = `hooks=${'y'.repeat(13_000)}`;
    const placement = windowsArgvPromptPlacement({
      file: 'C:\\node.exe',
      args: ['codex.js', '-c', hooks, big],
      prompt: big,
      channel: { kind: 'positional' },
    });
    expect(windowsCommandLineLength('C:\\node.exe', ['codex.js', '-c', hooks, big]))
      .toBeGreaterThan(WINDOWS_COMMAND_LINE_SAFE_LIMIT);
    expect(placement).toEqual({
      defer: true,
      reason: 'command-line-too-long',
      args: ['codex.js', '-c', hooks],
    });
  });

  it('canal interactive-flag tira a flag junto com o brief', () => {
    const placement = windowsArgvPromptPlacement({
      file: 'C:\\agy.cmd',
      args: ['--add-dir', 'C:\\w', '--prompt-interactive', brief],
      prompt: brief,
      channel: { kind: 'interactive-flag', flag: '--prompt-interactive' },
    });
    expect(placement).toEqual({ defer: true, reason: 'batch-launcher', args: ['--add-dir', 'C:\\w'] });
  });

  it('sem o brief no argv não há o que mover', () => {
    expect(windowsArgvPromptPlacement({
      file: 'C:\\npm\\claude.cmd',
      args: ['--model', 'opus'],
      prompt: brief,
      channel: { kind: 'positional' },
    })).toEqual({ defer: false });
  });
});
