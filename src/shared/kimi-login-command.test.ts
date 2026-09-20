import { describe, expect, it } from 'vitest';
import { kimiLoginCommand, kimiRegion } from './kimi-login-command';

describe('kimiRegion', () => {
  it('defaults to global when no locale is set', () => {
    expect(kimiRegion({})).toBe('global');
  });

  it('uses global for non-zh locales', () => {
    expect(kimiRegion({ LANG: 'en_US.UTF-8' })).toBe('global');
    expect(kimiRegion({ LANG: 'pt_BR.UTF-8' })).toBe('global');
    expect(kimiRegion({ LANG: 'ja_JP.UTF-8' })).toBe('global');
    expect(kimiRegion({ LANG: 'ko_KR.UTF-8' })).toBe('global');
    expect(kimiRegion({ LANG: 'C' })).toBe('global');
  });

  it('uses mainland-cn only for mainland China locales', () => {
    expect(kimiRegion({ LANG: 'zh_CN.UTF-8' })).toBe('mainland-cn');
    expect(kimiRegion({ LANG: 'zh-CN.UTF-8' })).toBe('mainland-cn');
    expect(kimiRegion({ LANG: 'zh_Hans.UTF-8' })).toBe('mainland-cn');
    expect(kimiRegion({ LANG: 'ZH_CN.UTF-8' })).toBe('mainland-cn');
  });

  it('keeps zh_TW / zh_HK / bare zh on global (English/Google OAuth)', () => {
    expect(kimiRegion({ LANG: 'zh_TW.UTF-8' })).toBe('global');
    expect(kimiRegion({ LANG: 'zh_HK.UTF-8' })).toBe('global');
    expect(kimiRegion({ LANG: 'zh' })).toBe('global');
  });

  it('LC_ALL takes precedence over LANG', () => {
    expect(kimiRegion({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('mainland-cn');
    expect(kimiRegion({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' })).toBe('global');
  });

  it('LC_CTYPE is checked when LC_ALL is absent', () => {
    expect(kimiRegion({ LC_CTYPE: 'zh_CN.UTF-8' })).toBe('mainland-cn');
    expect(kimiRegion({ LC_CTYPE: 'en_US.UTF-8' })).toBe('global');
  });
});

describe('kimiLoginCommand', () => {
  it('returns kimi login --region global for non-zh locale', () => {
    expect(kimiLoginCommand({ LANG: 'en_US.UTF-8' })).toBe('kimi login --region global');
    expect(kimiLoginCommand({})).toBe('kimi login --region global');
  });

  it('returns kimi login --region mainland-cn for zh locale', () => {
    expect(kimiLoginCommand({ LANG: 'zh_CN.UTF-8' })).toBe('kimi login --region mainland-cn');
  });

  it('the command is a safe single-line shell string (no metacharacters)', () => {
    const cmd = kimiLoginCommand({ LANG: 'en_US.UTF-8' });
    expect(cmd).not.toMatch(/[;&|<>$`\\\n\r]/);
    expect(cmd.trim().length).toBeGreaterThan(0);
  });
});
