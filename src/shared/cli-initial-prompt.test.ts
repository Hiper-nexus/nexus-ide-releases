import { describe, expect, it } from 'vitest';
import {
  acceptsInteractiveInitialPrompt,
  applyInitialPromptToArgv,
  initialPromptChannel,
  spawnBinaryName,
} from './cli-initial-prompt';

describe('initialPromptChannel', () => {
  it('herda o contrato do BINÁRIO, não do nome do adapter', () => {
    // glm/longcat/deepseek são adapters diferentes rodando o MESMO claude.
    for (const bin of ['claude', 'codex', 'grok', 'muse', 'qodercli']) {
      expect(initialPromptChannel({ interactive: [bin, '--model', 'x'] })).toEqual({
        kind: 'positional',
      });
    }
    // sakana é um wrapper do codex.
    expect(initialPromptChannel({ interactive: ['codex-fugu'] })).toEqual({
      kind: 'positional',
    });
  });

  it('cai na colagem para binário que não declara prompt posicional', () => {
    // kimi/gemini/qwen só têm `-p` (one-shot); aider/omp/prime-agent, nada.
    for (const bin of ['kimi', 'gemini', 'qwen', 'aider', 'omp', 'prime-agent']) {
      expect(initialPromptChannel({ interactive: [bin] })).toEqual({
        kind: 'paste',
      });
    }
  });

  it('respeita a declaração do adapter acima da herança do binário', () => {
    expect(
      initialPromptChannel({ declared: 'paste', interactive: ['claude'] }),
    ).toEqual({ kind: 'paste' });
    expect(
      initialPromptChannel({ declared: 'paste', interactive: ['devin'] }),
    ).toEqual({ kind: 'paste' });
    expect(
      initialPromptChannel({ declared: 'positional', interactive: ['aider'] }),
    ).toEqual({ kind: 'positional' });
  });

  it('one-shot carrega os argumentos que ligam o modo', () => {
    expect(
      initialPromptChannel({
        declared: 'oneshot',
        oneshotArgs: ['--print'],
        interactive: ['agy'],
      }),
    ).toEqual({ kind: 'oneshot', args: ['--print'] });
  });

  it('one-shot sem argumentos é contrato incompleto: vira colagem', () => {
    expect(
      initialPromptChannel({ declared: 'oneshot', interactive: ['agy'] }),
    ).toEqual({ kind: 'paste' });
    expect(
      initialPromptChannel({
        declared: 'oneshot',
        oneshotArgs: ['  '],
        interactive: ['agy'],
      }),
    ).toEqual({ kind: 'paste' });
  });

  it('reconhece o binário com caminho absoluto e extensão', () => {
    expect(
      initialPromptChannel({ interactive: ['/opt/homebrew/bin/claude'] }),
    ).toEqual({ kind: 'positional' });
    expect(
      initialPromptChannel({ interactive: ['C:\\tools\\codex.exe'] }),
    ).toEqual({ kind: 'positional' });
  });

  it('sem binário nenhum não inventa canal', () => {
    expect(initialPromptChannel({})).toEqual({ kind: 'paste' });
    expect(initialPromptChannel({ interactive: [] })).toEqual({ kind: 'paste' });
  });
});

describe('acceptsInteractiveInitialPrompt', () => {
  it('só o posicional mantém o pane vivo para o operador digitar', () => {
    expect(acceptsInteractiveInitialPrompt({ interactive: ['claude'] })).toBe(true);
    // one-shot fecha depois da tarefa: não serve para pane de missão vivo.
    expect(
      acceptsInteractiveInitialPrompt({
        declared: 'oneshot',
        oneshotArgs: ['--print'],
        interactive: ['agy'],
      }),
    ).toBe(false);
    expect(acceptsInteractiveInitialPrompt({ interactive: ['kimi'] })).toBe(false);
  });
});

describe('applyInitialPromptToArgv', () => {
  it('anexa posicional no fim — contrato do binário claude/codex/grok', () => {
    expect(
      applyInitialPromptToArgv(
        ['--model', 'deepseek-v4-pro'],
        { kind: 'positional' },
        'faça a tarefa',
      ),
    ).toEqual(['--model', 'deepseek-v4-pro', 'faça a tarefa']);
  });

  it('OpenCode oneshot: run na frente, prompt no fim', () => {
    expect(
      applyInitialPromptToArgv(
        ['--model', 'opencode/big-pickle', '--auto'],
        { kind: 'oneshot', args: ['run'] },
        'revise',
      ),
    ).toEqual(['run', '--model', 'opencode/big-pickle', '--auto', 'revise']);
  });

  it('AGY oneshot: --print e prompt no fim', () => {
    expect(
      applyInitialPromptToArgv(
        ['--add-dir', '/tmp/ws'],
        { kind: 'oneshot', args: ['--print'] },
        'mapeie',
      ),
    ).toEqual(['--add-dir', '/tmp/ws', '--print', 'mapeie']);
  });

  it('Devin positional anexa -- antes do prompt', () => {
    expect(
      applyInitialPromptToArgv(
        ['devin', '--model', 'swe-2-high'],
        { kind: 'positional' },
        'faça a tarefa',
      ),
    ).toEqual(['devin', '--model', 'swe-2-high', '--', 'faça a tarefa']);
  });

  it('colagem não mexe no argv', () => {
    expect(
      applyInitialPromptToArgv(['--model', 'k3'], { kind: 'paste' }, 'x'),
    ).toEqual(['--model', 'k3']);
  });
});

describe('spawnBinaryName', () => {
  it('reconhece o claude absoluto usado por DeepSeek/GLM', () => {
    expect(spawnBinaryName(['/opt/homebrew/bin/claude', '--model', 'x'])).toBe(
      'claude',
    );
  });
});
