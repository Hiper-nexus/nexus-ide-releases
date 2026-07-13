import { describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../state/settings-store';
import {
  resolveOpenDrawerSection,
  SETTINGS_DRAWER_DEFAULT_SECTION,
} from './settings-drawer-section';

describe('resolveOpenDrawerSection (SettingsDrawer panel selection)', () => {
  it('uses default when openDrawer() left no target', () => {
    expect(resolveOpenDrawerSection(null)).toBe(SETTINGS_DRAWER_DEFAULT_SECTION);
    expect(resolveOpenDrawerSection(undefined)).toBe(
      SETTINGS_DRAWER_DEFAULT_SECTION,
    );
    expect(SETTINGS_DRAWER_DEFAULT_SECTION).toBe('account');
  });

  it('honors targeted openDrawer(section)', () => {
    expect(resolveOpenDrawerSection('providers')).toBe('providers');
    expect(resolveOpenDrawerSection('ranking')).toBe('ranking');
  });

  it('store path: providers → close → generic open does not keep providers target', () => {
    useSettingsStore.setState({ drawerOpen: false, drawerSection: null });
    useSettingsStore.getState().openDrawer('providers');
    expect(useSettingsStore.getState().drawerSection).toBe('providers');
    // What SettingsDrawer would show while open with target:
    expect(
      resolveOpenDrawerSection(useSettingsStore.getState().drawerSection),
    ).toBe('providers');

    useSettingsStore.getState().closeDrawer();
    expect(useSettingsStore.getState().drawerSection).toBeNull();

    useSettingsStore.getState().openDrawer();
    expect(useSettingsStore.getState()).toMatchObject({
      drawerOpen: true,
      drawerSection: null,
    });
    // Local useState would have been "providers" before fix; production resolver
    // must force default so the panel is fresh.
    expect(
      resolveOpenDrawerSection(useSettingsStore.getState().drawerSection),
    ).toBe('account');
  });
});
