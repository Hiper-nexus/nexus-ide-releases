import type { SettingsSection } from './settings-nav';

/** Default section when settings opens without an explicit destination. */
export const SETTINGS_DRAWER_DEFAULT_SECTION: SettingsSection = 'account';

/** Resolve the canonical settings section, resuming the last stored section. */
export function resolveOpenDrawerSection(
  requestedSection: SettingsSection | null | undefined,
): SettingsSection {
  return requestedSection ?? SETTINGS_DRAWER_DEFAULT_SECTION;
}
