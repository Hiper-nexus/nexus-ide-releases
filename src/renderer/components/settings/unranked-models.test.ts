import { describe, expect, it } from 'vitest';
import type { PublicModelRankingEntry } from '../../../shared/eval-ranking-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { unrankedModels } from './unranked-models';

const models = [
  'xiaomi/mimo-v2.6-flash',
  'xiaomi/mimo-v2.6-pro',
  'xiaomi/mimo-v2.6-pro-ultraspeed',
];
const provider = {
  adapterId: 'mimo-code', label: 'MiMo Code', kind: 'cli-pty',
  installed: true, enabled: true, models,
  modelInfo: { [models[0]]: { id: models[0], costTier: 'low' } },
} satisfies Partial<ProviderSettingsInfo>;

describe('unrankedModels', () => {
  it('lists all available MiMo variants without fabricated quality, rank or evaluation date', () => {
    const candidates = unrankedModels([provider], []);
    expect(candidates.map((row) => row.modelId)).toEqual(models);
    expect(candidates[0]).toMatchObject({
      id: `mimo-code/${models[0]}`, adapterId: 'mimo-code',
      label: 'MiMo Code', costTier: 'low', installed: true,
    });
    for (const candidate of candidates) {
      expect(candidate).not.toHaveProperty('overall');
      expect(candidate).not.toHaveProperty('rank');
      expect(candidate).not.toHaveProperty('evaluatedAt');
    }
  });

  it('deduplicates by adapter and model, removing only published entries for that provider', () => {
    const scored = [{ adapterId: 'mimo-code', modelId: models[0] }] as PublicModelRankingEntry[];
    const candidates = unrankedModels([
      { ...provider, models: [...models, models[1]] },
      { ...provider, adapterId: 'other-cli', models: [models[0]] },
    ], scored);
    expect(candidates.map((row) => row.id)).toEqual([
      `mimo-code/${models[1]}`, `mimo-code/${models[2]}`, `other-cli/${models[0]}`,
    ]);
  });

  it('keeps missing and disabled tools visible without claiming they are ready for a benchmark', () => {
    const candidates = unrankedModels([{ ...provider, enabled: false }], []);
    expect(candidates.every((row) => row.installed === false)).toBe(true);
  });
});
