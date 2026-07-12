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
  });
});
