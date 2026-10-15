import { describe, expect, it } from 'vitest';
import {
  resolveOpenDrawerSection,
  SETTINGS_DRAWER_DEFAULT_SECTION,
} from './settings-drawer-section';

describe('resolveOpenDrawerSection', () => {
  it('opens the setup guide when no destination is provided', () => {
    expect(resolveOpenDrawerSection(null)).toBe(SETTINGS_DRAWER_DEFAULT_SECTION);
    expect(resolveOpenDrawerSection(undefined)).toBe(
      SETTINGS_DRAWER_DEFAULT_SECTION,
    );
    expect(SETTINGS_DRAWER_DEFAULT_SECTION).toBe('getting-started');
  });

  it('preserves an explicit product settings section', () => {
    expect(resolveOpenDrawerSection('providers')).toBe('providers');
    expect(resolveOpenDrawerSection('ranking')).toBe('ranking');
  });
});

it('sends the retired Jev decisions tab to Auditoria, where the history now lives', () => {
  expect(resolveOpenDrawerSection('jev-decisions')).toBe('audit');
});
