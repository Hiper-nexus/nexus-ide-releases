import { describe, expect, it } from 'vitest';
import {
  MODEL_DISCOVERY_CAP,
  MODEL_DISCOVERY_INVENTORY,
  parseAgyModelsOutput,
  parseCursorAgentModelsOutput,
  parseGrokModelsOutput,
  parseKimiModelsOutput,
  parseOmpModelsOutput,
  parseOpenCodeModelsOutput,
  parsePrimeAgentModelsOutput,
  parseQoderModelsOutput,
  sanitizeDiscoveredModels,
  supportsModelDiscovery,
} from './model-discovery';

describe('model discovery', () => {
  it('covers all catalog CLIs and only wires live exec where a list command exists', () => {
    expect(Object.keys(MODEL_DISCOVERY_INVENTORY)).toHaveLength(19);
    const live = Object.entries(MODEL_DISCOVERY_INVENTORY)
      .filter(([, entry]) => entry.kind === 'cli')
      .map(([id]) => id)
      .sort();
    expect(live).toEqual([
      'agy',
      'cursor-agent',
      'grok',
      'kimi',
      'omp',
      'opencode',
      'prime-agent',
      'qoder',
    ]);
    for (const id of live) {
      expect(supportsModelDiscovery(id)).toBe(true);
    }
    expect(supportsModelDiscovery('claude')).toBe(false);
    expect(supportsModelDiscovery('codex')).toBe(false);
    expect(supportsModelDiscovery('glm')).toBe(false);
    expect(supportsModelDiscovery('glm-flash')).toBe(false);
    expect(supportsModelDiscovery('aider')).toBe(false);
    expect(supportsModelDiscovery('gemini')).toBe(false);
    expect(supportsModelDiscovery('desconhecido')).toBe(false);
  });

  it('documents honest fallbacks instead of pretending discovery', () => {
    expect(MODEL_DISCOVERY_INVENTORY.claude.kind).toBe('cache');
    expect(MODEL_DISCOVERY_INVENTORY.codex.kind).toBe('cache');
    expect(MODEL_DISCOVERY_INVENTORY.aider.kind).toBe('bundled');
    expect(MODEL_DISCOVERY_INVENTORY.glm.reason).toMatch(/claude/);
    expect(MODEL_DISCOVERY_INVENTORY['glm-flash'].kind).toBe('bundled');
    expect(MODEL_DISCOVERY_INVENTORY['glm-flash'].reason).toMatch(/claude/);
    expect(MODEL_DISCOVERY_INVENTORY.deepseek.kind).toBe('bundled');
    expect(MODEL_DISCOVERY_INVENTORY).not.toHaveProperty('gemini');
    expect(MODEL_DISCOVERY_INVENTORY.muse.kind).toBe('bundled');
    expect(MODEL_DISCOVERY_INVENTORY.sakana.kind).toBe('bundled');
  });

  it('parses AGY TSV the same way `agy models` prints it', () => {
    expect(
      parseAgyModelsOutput(
        [
          'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
          'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
          'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
          'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
        ].join('\n'),
      ),
    ).toEqual([
      'gemini-3.7-flash-high',
      'gemini-3.7-flash-medium',
      'gemini-3.7-flash-low',
      'gemini-3.6-flash-high',
    ]);
  });

  it('parses AGY JSON envelopes from `agy --output-format json models`', () => {
    expect(
      parseAgyModelsOutput(
        JSON.stringify({
          command: {
            name: 'models',
            data: {
              models: [
                { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
                { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
              ],
            },
          },
        }),
      ),
    ).toEqual(['gemini-3.7-flash-high', 'gemini-3.7-flash-low']);
  });

  it('parses Grok bullet lists including the default marker', () => {
    expect(
      parseGrokModelsOutput(
        [
          'You are not authenticated.',
          '',
          'Default model: grok-4.5',
          '',
          'Available models:',
          '  - grok-4.6',
          '  * grok-4.5 (default)',
        ].join('\n'),
      ),
    ).toEqual(['grok-4.6', 'grok-4.5']);
  });

  it('parses Kimi provider JSON maps', () => {
    expect(
      parseKimiModelsOutput(
        JSON.stringify({ models: { 'kimi-code/k3': {}, 'kimi-code/kimi-for-coding': {} } }),
      ),
    ).toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding']);
  });

  it('parses OpenCode one-id-per-line output', () => {
    expect(
      parseOpenCodeModelsOutput(
        ['opencode/big-pickle', 'opencode/hy3-free', 'openrouter/anthropic/claude-sonnet-5'].join(
          '\n',
        ),
      ),
    ).toEqual([
      'opencode/big-pickle',
      'opencode/hy3-free',
      'openrouter/anthropic/claude-sonnet-5',
    ]);
  });

  it('parses Cursor Agent `id - Label` lists and skips the header', () => {
    expect(
      parseCursorAgentModelsOutput(
        [
          'Available models',
          '',
          'auto - Auto (current, default)',
          'gpt-5.6-sol-high - GPT-5.6 Sol 1M High',
          'composer-2.5 - Composer 2.5',
        ].join('\n'),
      ),
    ).toEqual(['auto', 'gpt-5.6-sol-high', 'composer-2.5']);
  });

  it('parses Qoder --list-models names including the MODEL header', () => {
    expect(
      parseQoderModelsOutput(
        ['MODEL', 'Auto', 'Qwen3.8-Max', 'DeepSeek-V4-Flash', 'Kimi-K3'].join('\n'),
      ),
    ).toEqual(['Auto', 'Qwen3.8-Max', 'DeepSeek-V4-Flash', 'Kimi-K3']);
  });

  it('parses Prime Agent model-list tables as the model column', () => {
    expect(
      parsePrimeAgentModelsOutput(
        [
          'provider      model                       context  max-out  thinking  images',
          'anthropic     claude-opus-5               1M       128K     yes       yes',
          'openai-codex  gpt-5.6-terra               272K     128K     yes       yes',
          'deepseek      deepseek-v4-flash           1M       384K     yes       no',
        ].join('\n'),
      ),
    ).toEqual(['claude-opus-5', 'gpt-5.6-terra', 'deepseek-v4-flash']);
  });

  it('parses OMP models --json preferring selector over bare id', () => {
    expect(
      parseOmpModelsOutput(
        JSON.stringify({
          models: [
            { provider: 'anthropic', id: 'claude-opus-5', selector: 'anthropic/claude-opus-5' },
            { provider: 'xai-oauth', id: 'grok-4.5' },
          ],
        }),
      ),
    ).toEqual(['anthropic/claude-opus-5', 'grok-4.5']);
  });

  it('sanitizes ids: shape, dedupe and cap', () => {
    expect(
      sanitizeDiscoveredModels([
        'kimi-code/k3',
        'kimi-code/k3',
        '  kimi-code/kimi-for-coding  ',
        'id inválido com espaço',
        '-começa-com-hifen',
        'x'.repeat(200),
        'ok.id:v1',
        'openrouter/~anthropic/claude-fable-latest',
      ]),
    ).toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding', 'ok.id:v1']);
  });

  it('caps the list so a models.dev dump cannot flood the dropdown', () => {
    const many = Array.from({ length: MODEL_DISCOVERY_CAP + 40 }, (_, i) => `model-${i}`);
    expect(sanitizeDiscoveredModels(many)).toHaveLength(MODEL_DISCOVERY_CAP);
  });
});
