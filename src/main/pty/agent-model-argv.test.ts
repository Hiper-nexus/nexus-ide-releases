import { describe, expect, it } from 'vitest';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import {
  argvHonorsModel,
  firstDeclaredModel,
  interactiveTemplateForModel,
} from './agent-model-argv';

interface ManifestShape {
  id: string;
  spawn: { interactive: string[]; headless?: string[] };
  models?: { flag?: string };
}

/**
 * F-722: o manifesto do Qwen montava `-m {{MODEL}}` com `models.flag` em
 * `--model`. A trava `argvHonorsModel` recusava todo spawn com modelo ("modelo
 * selado não entrou no argv"), e sem modelo sobrava um `-m` solto. Todo
 * manifesto embutido precisa montar o modelo com a MESMA flag que declara.
 */
describe('manifestos embutidos montam o modelo com a flag declarada (F-722)', () => {
  const probe = 'probe-model';
  const cases = (BUILTIN_ADAPTERS as ManifestShape[]).flatMap((adapter) =>
    (['interactive', 'headless'] as const)
      .map((mode) => ({ id: adapter.id, mode, flag: adapter.models?.flag, template: adapter.spawn[mode] ?? [] }))
      .filter(({ template }) => template.some((arg) => arg.includes('{{MODEL}}'))),
  );
  it.each(cases)('$id ($mode)', ({ flag, template }) => {
    const argv = template.map((arg) => arg.replace('{{MODEL}}', probe));
    expect(argvHonorsModel(argv, flag, probe)).toBe(true);
    const withoutModel = interactiveTemplateForModel(template, flag, '');
    expect(withoutModel.some((arg) => arg.includes('{{MODEL}}'))).toBe(false);
    if (flag && !flag.endsWith('=')) expect(withoutModel).not.toContain(flag);
  });
});

describe('firstDeclaredModel', () => {
  it('ignores empty picks — "padrão da ferramenta" is not a model', () => {
    expect(firstDeclaredModel(['', undefined, 'claude-sonnet-5'])).toBe(
      'claude-sonnet-5',
    );
    expect(firstDeclaredModel(['   ', null, 'gpt-5.6-luna'])).toBe('gpt-5.6-luna');
  });

  it('keeps the first real pick', () => {
    expect(firstDeclaredModel(['grok-build', 'fallback'])).toBe('grok-build');
  });

  it('returns empty when nothing was declared anywhere', () => {
    expect(firstDeclaredModel(['', undefined, ''])).toBe('');
    expect(firstDeclaredModel([])).toBe('');
  });
});

describe('interactiveTemplateForModel', () => {
  const claude = ['claude', '--model', '{{MODEL}}'];

  it('keeps the template untouched when there is a model', () => {
    expect(interactiveTemplateForModel(claude, '--model', 'claude-opus-5')).toEqual(
      claude,
    );
  });

  it('drops the orphan flag when the model is empty', () => {
    // Sem isto o spawn vira `claude --model` e o pane morre no boot.
    expect(interactiveTemplateForModel(claude, '--model', '')).toEqual([
      'claude',
    ]);
    expect(interactiveTemplateForModel(claude, '--model', '  ')).toEqual([
      'claude',
    ]);
  });

  it('drops an inline placeholder without eating the previous argument', () => {
    expect(
      interactiveTemplateForModel(
        ['agy', '--add-dir', '{{CWD}}', '--model={{MODEL}}'],
        '--model',
        '',
      ),
    ).toEqual(['agy', '--add-dir', '{{CWD}}']);
  });

  it('leaves templates without a model placeholder alone', () => {
    expect(interactiveTemplateForModel(['codex'], '--model', '')).toEqual([
      'codex',
    ]);
  });
});

describe('argvHonorsModel', () => {
  it('exige a flag e o valor selado — omissão é o default silencioso', () => {
    expect(argvHonorsModel(['--sandbox'], '--model', 'gpt-5.6-sol')).toBe(false);
    expect(
      argvHonorsModel(['--model', 'gpt-5.6-sol'], '--model', 'gpt-5.6-sol'),
    ).toBe(true);
    expect(argvHonorsModel(['--model', 'gpt-5.6-luna'], '--model', 'gpt-5.6-sol')).toBe(
      false,
    );
  });
});
