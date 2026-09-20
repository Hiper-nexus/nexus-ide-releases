import { describe, expect, it } from 'vitest';
import { kimiLoginRegionRequest } from './kimi-login-region';

describe('kimiLoginRegionRequest — F-354', () => {
  it('offers kimi.ai and kimi.com, with the locale default marked primary', () => {
    const global = kimiLoginRegionRequest('global');
    expect(global.title).toMatch(/kimi/i);
    expect(global.options.map((option) => option.value)).toEqual([
      'global',
      'mainland-cn',
    ]);
    expect(global.options[0]?.primary).toBe(true);
    expect(global.options[1]?.primary).toBe(false);
    expect(global.options[0]?.detail).toMatch(/kimi\.ai\/code\/authorize_device/);
    expect(global.options[1]?.detail).toMatch(/chinês/);

    const mainland = kimiLoginRegionRequest('mainland-cn');
    expect(mainland.options[0]?.primary).toBe(false);
    expect(mainland.options[1]?.primary).toBe(true);
  });
});
