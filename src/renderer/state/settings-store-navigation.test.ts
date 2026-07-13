import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from './settings-store';

describe('settings drawer navigation target', () => {
  beforeEach(() => {
    useSettingsStore.setState({ drawerOpen: false, drawerSection: null });
  });

  it('opens directly on providers for CLI account management', () => {
    useSettingsStore.getState().openDrawer('providers');
    expect(useSettingsStore.getState()).toMatchObject({
      drawerOpen: true,
      drawerSection: 'providers',
    });
  });

  it('does not reuse a targeted section for a generic open', () => {
    useSettingsStore.getState().openDrawer('providers');
    useSettingsStore.getState().closeDrawer();
    useSettingsStore.getState().openDrawer();
    expect(useSettingsStore.getState().drawerSection).toBeNull();
    // Panel resolution after generic reopen is tested in settings-drawer-section.test.ts
    // (resolveOpenDrawerSection(null) → account), matching SettingsDrawer effect.
  });

  it('closeDrawer clears drawerSection', () => {
    useSettingsStore.getState().openDrawer('ranking');
    useSettingsStore.getState().closeDrawer();
    expect(useSettingsStore.getState()).toMatchObject({
      drawerOpen: false,
      drawerSection: null,
    });
  });

  it('toggleDrawer close also clears drawerSection', () => {
    useSettingsStore.getState().openDrawer('providers');
    useSettingsStore.getState().toggleDrawer();
    expect(useSettingsStore.getState()).toMatchObject({
      drawerOpen: false,
      drawerSection: null,
    });
  });

  it('manual nav can retarget drawerSection while open', () => {
    useSettingsStore.getState().openDrawer('account');
    // Mirrors SettingsDrawer.selectSection — keeps store in sync with user pick.
    useSettingsStore.setState({ drawerSection: 'providers' });
    expect(useSettingsStore.getState().drawerSection).toBe('providers');
    useSettingsStore.getState().closeDrawer();
    expect(useSettingsStore.getState().drawerSection).toBeNull();
  });
});
