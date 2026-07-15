import type { SettingsSection } from './settings-nav';

/** Default panel when the drawer opens without an openDrawer(section) target. */
export const SETTINGS_DRAWER_DEFAULT_SECTION: SettingsSection = 'account';

/**
 * Resolve which settings panel to show when the drawer is open.
 * - Targeted open (openDrawer('providers')) → that section
 * - Soft-reopen after close keeps last section in the store → resume there
 * - Truly null target (first open) → default account panel
 *
 * Pure; used by SettingsDrawer so tests drive the same function as production.
 */
export function resolveOpenDrawerSection(
  requestedSection: SettingsSection | null | undefined,
): SettingsSection {
  return requestedSection ?? SETTINGS_DRAWER_DEFAULT_SECTION;
}
