import { expect, it } from 'vitest';
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog';
it('exposes MiMo launch models and its real native picker without invented effort flags', () => {
  const catalog=getAgentSessionOptionCatalog('mimo-code');
  expect(catalog?.models.map(m=>m.id)).toContain('xiaomi/mimo-v2.6-pro');
  expect(catalog?.models.every(m=>m.options.length===0)).toBe(true);
  expect(catalog?.modelApply.launchArgs?.('xiaomi/mimo-v2.6-pro')).toEqual(['--model','xiaomi/mimo-v2.6-pro']);
  expect(catalog?.modelApply.midSession).toEqual({kind:'agent-picker',command:'/models',delivery:'type'});
});
