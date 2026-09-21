import { expect, it } from 'vitest';
import { GROK_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-grok';

it('offers Grok 4.7 with the provider-supported effort levels and launch flags', () => {
  const model = GROK_SESSION_OPTION_CATALOG.models.find((entry) => entry.id === 'grok-4.7');
  expect(model?.isDefault).toBe(true);
  const effort = model?.options.find((option) => option.id === 'effort');
  expect(effort?.kind).toMatchObject({ type: 'select', defaultValue: 'high' });
  if (effort?.kind.type !== 'select') throw new Error('Grok effort selector missing');
  expect(effort.kind.choices.map((choice) => choice.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(effort.apply.launchArgs?.('xhigh')).toEqual(['--reasoning-effort', 'xhigh']);
  expect(GROK_SESSION_OPTION_CATALOG.modelApply.launchArgs?.('grok-4.7')).toEqual(['-m', 'grok-4.7']);
});
