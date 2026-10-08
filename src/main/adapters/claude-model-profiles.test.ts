import { describe, expect, it } from 'vitest';
import claudeAdapter from '../../adapters/builtin/claude.json';
import { BUILTIN_MODEL_CATALOG, loadModelCatalog, modelCatalogInfo } from './model-catalog';
import {
  claudeEffortArgsForModel,
  claudeEffortForModel,
  claudeModelContextWindow,
  claudeModelVersionWarning,
  resolveClaudeModel,
  withClaudeModelProfile,
} from './claude-model-profiles';

const FLAG = '--effort';

describe('F-966: esforço do Claude por modelo', () => {
  it('argv de cada modelo do adapter para --effort xhigh e max', () => {
    const snapshot = Object.fromEntries(
      claudeAdapter.models.list.map((model) => [
        model,
        [
          claudeEffortArgsForModel(['--model', model, FLAG, 'xhigh'], FLAG, model).slice(2).join(' '),
          claudeEffortArgsForModel([FLAG, 'max'], FLAG, model).join(' '),
        ],
      ]),
    );
    expect(snapshot).toEqual({
      'claude-opus-5-5': ['--effort xhigh', '--effort max'],
      'claude-opus-5': ['--effort xhigh', '--effort max'],
      'claude-opus-4-8': ['--effort xhigh', '--effort max'],
      'claude-fable-5-1': ['--effort xhigh', '--effort max'],
      // Fora do manifesto: passa intacto, a CLI decide.
      'claude-mythos-5-1': ['--effort xhigh', '--effort max'],
      'claude-fable-5': ['--effort xhigh', '--effort max'],
      'claude-sonnet-5-5': ['--effort xhigh', '--effort max'],
      'claude-sonnet-5': ['--effort xhigh', '--effort max'],
      'claude-haiku-5-5': ['--effort xhigh', '--effort max'],
      'claude-opus-4-7': ['--effort max', '--effort max'],
      'claude-haiku-4-5': ['', ''],
      'claude-sonnet-4-6': ['--effort high', '--effort high'],
      'claude-opus-4-6': ['--effort high', '--effort max'],
      'claude-sonnet-4-5': ['', ''],
      'claude-opus-4-5': ['--effort high', '--effort high'],
    });
  });

  it('haiku-4-5 não recebe esforço; opus-4-7 troca xhigh por max', () => {
    expect(claudeEffortForModel('claude-haiku-4-5', 'high')).toBeUndefined();
    expect(claudeEffortForModel('claude-opus-4-7', 'xhigh')).toBe('max');
    expect(claudeEffortForModel('claude-opus-4-7', 'high')).toBe('high');
    expect(claudeEffortForModel('claude-sonnet-4-6', 'max')).toBe('high');
    expect(claudeEffortForModel('claude-opus-5-5', 'max')).toBe('max');
  });

  it('aceita o sufixo [1m] e os aliases com versão, nunca a família nua', () => {
    expect(claudeEffortForModel('claude-sonnet-4-6[1m]', 'max')).toBe('high');
    expect(claudeEffortForModel('haiku-4.5', 'high')).toBeUndefined();
    expect(resolveClaudeModel('haiku')).toBeNull();
    expect(claudeEffortForModel('haiku', 'high')).toBe('high');
    expect(claudeEffortForModel('glm-5.3', 'xhigh')).toBe('xhigh');
    expect(claudeEffortForModel('claude-opus-4-7', '')).toBeUndefined();
  });

  it('reescreve a forma --effort=X e preserva o resto do argv', () => {
    expect(claudeEffortArgsForModel(['--verbose', '--effort=xhigh', '--x'], FLAG, 'claude-opus-4-7'))
      .toEqual(['--verbose', '--effort=max', '--x']);
    expect(claudeEffortArgsForModel(['--effort=low', '--verbose'], FLAG, 'claude-haiku-4-5'))
      .toEqual(['--verbose']);
  });
});

describe('F-966: janela e versão mínima', () => {
  it('janela do Claude Code: [1m] só onde o perfil aceita', () => {
    expect(claudeModelContextWindow('claude-sonnet-4-6')).toBe(200_000);
    expect(claudeModelContextWindow('claude-sonnet-4-6[1m]')).toBe(1_000_000);
    expect(claudeModelContextWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(claudeModelContextWindow('claude-haiku-4-5[1m]')).toBe(200_000);
    expect(claudeModelContextWindow('claude-sonnet-4-5')).toBeUndefined();
  });

  it('versão abaixo do minVersion avisa; igual, acima ou desconhecida não', () => {
    expect(claudeModelVersionWarning('claude-sonnet-5-5', '2.1.283')).toMatch(
      /v2\.1\.283 .*v2\.1\.284.*Claude Sonnet 5\.5/,
    );
    expect(claudeModelVersionWarning('claude-sonnet-5-5', '2.1.284')).toBeUndefined();
    expect(claudeModelVersionWarning('claude-haiku-5-5', '2.1.291')).toMatch(/v2\.1\.293/);
    expect(claudeModelVersionWarning('claude-haiku-5-5', '2.1.293')).toBeUndefined();
    expect(claudeModelVersionWarning('claude-sonnet-5-5', null)).toBeUndefined();
    expect(claudeModelVersionWarning('claude-sonnet-4-6', '1.0.0')).toBeUndefined();
  });

  it('o catálogo leva esforços, versão mínima e janela sem esconder o default', () => {
    expect(withClaudeModelProfile({ id: 'claude-haiku-4-5' })).toMatchObject({
      efforts: [],
      maxContext: 200_000,
    });
    expect(withClaudeModelProfile({ id: 'claude-sonnet-5-5', maxContext: 7 })).toEqual({
      id: 'claude-sonnet-5-5',
      maxContext: 7,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      minCliVersion: '2.1.284',
    });
    const catalog = loadModelCatalog('/nonexistent/nexus-f966-catalog.json');
    expect(modelCatalogInfo(catalog, 'claude', 'claude-haiku-5-5')).toMatchObject({
      minCliVersion: '2.1.293',
      maxContext: 1_000_000,
    });
    expect(modelCatalogInfo(catalog, 'claude', 'claude-opus-4-7')?.efforts).toContain('max');
    expect(BUILTIN_MODEL_CATALOG.adapters?.claude?.default).toBe('claude-sonnet-5-5');
    expect(claudeAdapter.models.default).toBe('claude-sonnet-5-5');
    expect(claudeAdapter.models.list).toContain('claude-haiku-5-5');
    expect(claudeAdapter.control.effort.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
