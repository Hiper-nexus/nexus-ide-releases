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

  it('soft-close keeps the last section so reopen resumes the same panel', () => {
    useSettingsStore.getState().openDrawer('providers');
    useSettingsStore.getState().closeDrawer();
    expect(useSettingsStore.getState()).toMatchObject({
      drawerOpen: false,
      drawerSection: 'providers',
    });
    useSettingsStore.getState().openDrawer();
    expect(useSettingsStore.getState()).toMatchObject({
      drawerOpen: true,
      drawerSection: 'providers',
    });
  });

  it('explicit openDrawer(section) still retargets', () => {
    useSettingsStore.getState().openDrawer('ranking');
    useSettingsStore.getState().closeDrawer();
    useSettingsStore.getState().openDrawer('providers');
    expect(useSettingsStore.getState()).toMatchObject({
      drawerOpen: true,
      drawerSection: 'providers',
    });
  });

  it('toggleDrawer soft-close also keeps drawerSection', () => {
    useSettingsStore.getState().openDrawer('providers');
    useSettingsStore.getState().toggleDrawer();
    expect(useSettingsStore.getState()).toMatchObject({
      drawerOpen: false,
      drawerSection: 'providers',
    });
  });

  it('manual nav can retarget drawerSection while open', () => {
    useSettingsStore.getState().openDrawer('account');
    // Mirrors SettingsDrawer.selectSection — keeps store in sync with user pick.
    useSettingsStore.setState({ drawerSection: 'providers' });
    expect(useSettingsStore.getState().drawerSection).toBe('providers');
    useSettingsStore.getState().closeDrawer();
    expect(useSettingsStore.getState().drawerSection).toBe('providers');
  });
});
