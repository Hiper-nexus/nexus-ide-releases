import { describe, expect, it } from 'vitest';
import {
  resolveOpenDrawerSection,
  SETTINGS_DRAWER_DEFAULT_SECTION,
} from './settings-drawer-section';

describe('resolveOpenDrawerSection', () => {
  it('uses the account section when no destination is provided', () => {
    expect(resolveOpenDrawerSection(null)).toBe(SETTINGS_DRAWER_DEFAULT_SECTION);
    expect(resolveOpenDrawerSection(undefined)).toBe(
      SETTINGS_DRAWER_DEFAULT_SECTION,
    );
    expect(SETTINGS_DRAWER_DEFAULT_SECTION).toBe('account');
  });

  it('preserves an explicit product settings section', () => {
    expect(resolveOpenDrawerSection('providers')).toBe('providers');
    expect(resolveOpenDrawerSection('ranking')).toBe('ranking');
  });
});
