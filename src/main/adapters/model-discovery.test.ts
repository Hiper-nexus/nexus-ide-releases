import { describe, expect, it } from 'vitest';
import {
  sanitizeDiscoveredModels,
  supportsModelDiscovery,
} from './model-discovery';

describe('model discovery', () => {
  it('kimi is discoverable; token-based adapters are not', () => {
    expect(supportsModelDiscovery('kimi')).toBe(true);
    expect(supportsModelDiscovery('glm')).toBe(false);
    expect(supportsModelDiscovery('desconhecido')).toBe(false);
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
      ]),
    ).toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding', 'ok.id:v1']);
  });

  it('caps the list at 64 models', () => {
    const many = Array.from({ length: 100 }, (_, i) => `model-${i}`);
    expect(sanitizeDiscoveredModels(many)).toHaveLength(64);
  });
});
