import { describe, expect, it } from 'vitest';
import {
  acceptsInteractiveInitialPrompt,
  applyInitialPromptToArgv,
  initialPromptChannel,
  spawnBinaryName,
  nativeArgvPromptFits,
  WINDOWS_NATIVE_PROMPT_MAX_CHARS,
} from './cli-initial-prompt';
import { BUILTIN_ADAPTERS } from '../adapters/builtin';
import { assertSafePtyPrompt } from '../main/orch/pty-prompt-safety';
import { F958_BRIEF, F958_LONG_UPSTREAM_PATH } from '../test/f958-brief';

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

describe('brief no argv do Windows (F-669)', () => {
  it('acima do teto o brief não vai pela linha de comando no Windows', () => {
    const fits = 'x'.repeat(WINDOWS_NATIVE_PROMPT_MAX_CHARS);
    const tooLong = 'x'.repeat(WINDOWS_NATIVE_PROMPT_MAX_CHARS + 1);
    expect(nativeArgvPromptFits(fits, 'win32')).toBe(true);
    expect(nativeArgvPromptFits(tooLong, 'win32')).toBe(false);
    // O CreateProcess aceita 32.767 caracteres na linha inteira.
    expect(WINDOWS_NATIVE_PROMPT_MAX_CHARS).toBeLessThan(32_767);
    expect(nativeArgvPromptFits(tooLong, 'darwin')).toBe(true);
    expect(nativeArgvPromptFits(undefined, 'win32')).toBe(true);
  });
});

describe('F-958 — brief real de ~3,5 KB chega íntegro a cada adapter afetado', () => {
  const builtin = (id: string) => {
    const raw = BUILTIN_ADAPTERS.find((entry) => (entry as { id?: string }).id === id) as {
      spawn: {
        interactive: string[];
        initialPrompt?: 'positional' | 'interactive-flag' | 'oneshot' | 'paste';
        initialPromptFlag?: string;
        initialPromptArgs?: string[];
      };
    };
    return raw.spawn;
  };
  const channelFor = (id: string) => {
    const spawn = builtin(id);
    return initialPromptChannel({
      declared: spawn.initialPrompt ?? null,
      interactiveFlag: spawn.initialPromptFlag ?? null,
      oneshotArgs: spawn.initialPromptArgs ?? null,
      interactive: spawn.interactive,
    });
  };

  it('o brief passa pela trava de controle de terminal sem mudar um byte', () => {
    expect(F958_BRIEF.length).toBeGreaterThan(3_400);
    expect(assertSafePtyPrompt(F958_BRIEF)).toBe(F958_BRIEF);
    expect(F958_BRIEF).toContain(F958_LONG_UPSTREAM_PATH);
  });

  it.each([
    ['agy', ['agy', '--model', 'gemini-3.8-flash-high'], ['--print']],
    ['mimo-code', ['mimo', '--trust', '--model', 'xiaomi/mimo-v2.6-pro'], ['--prompt']],
  ])('%s recebe o brief como UM argumento, depois da flag do canal', (id, base, flag) => {
    const argv = applyInitialPromptToArgv(base, channelFor(id), F958_BRIEF);
    expect(argv.slice(0, base.length)).toEqual(base);
    expect(argv.slice(base.length)).toEqual([...flag, F958_BRIEF]);
    expect(nativeArgvPromptFits(F958_BRIEF, 'darwin')).toBe(true);
    expect(nativeArgvPromptFits(F958_BRIEF, 'win32')).toBe(true);
  });

  it('kimi não tem canal de argv: o brief vai por colagem depois do composer', () => {
    expect(channelFor('kimi')).toEqual({ kind: 'paste' });
    expect(applyInitialPromptToArgv(['kimi'], channelFor('kimi'), F958_BRIEF)).toEqual(['kimi']);
  });
});
