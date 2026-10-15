import type { SettingsSection } from './settings-nav';

/** Default section when settings opens without an explicit destination. */
export const SETTINGS_DRAWER_DEFAULT_SECTION: SettingsSection = 'getting-started';

/**
 * Seções que deixaram de ter aba própria e vivem dentro de outra página.
 * Links antigos (toasts, ⌘K, deep links) continuam chegando ao lugar certo.
 */
const MERGED_SECTIONS: Partial<Record<SettingsSection, SettingsSection>> = {
  // Decisões do Jev é histórico de decisões: mora na Auditoria.
  'jev-decisions': 'audit',
};

/** Resolve the canonical settings section, resuming the last stored section. */
export function resolveOpenDrawerSection(
  requestedSection: SettingsSection | null | undefined,
): SettingsSection {
  const section = requestedSection ?? SETTINGS_DRAWER_DEFAULT_SECTION;
  return MERGED_SECTIONS[section] ?? section;
}
