import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../state/settings-store';
import { trapDialogTabKey } from './settings-dialog-focus';
import {
  resolveOpenDrawerSection,
  SETTINGS_DRAWER_DEFAULT_SECTION,
} from './settings-drawer-section';
import type { SettingsSection } from './settings-nav';
import { SettingsSurface } from './SettingsWorkspace';

export type { SettingsSection };

/**
 * Transitional modal owner. The navigation and section rendering live in
 * SettingsSurface so the drawer and full-page destination cannot drift.
 */
export function SettingsDrawer() {
  const open = useSettingsStore((state) => state.drawerOpen);
  const requestedSection = useSettingsStore((state) => state.drawerSection);
  const close = useSettingsStore((state) => state.closeDrawer);
  const [section, setSection] = useState<SettingsSection>(
    SETTINGS_DRAWER_DEFAULT_SECTION,
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setSection(resolveOpenDrawerSection(requestedSection));
  }, [open, requestedSection]);

  useEffect(() => {
    if (!open) return undefined;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusFrame = window.requestAnimationFrame(() => {
      (searchRef.current ?? dialogRef.current)?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (
        event.key === 'Tab' &&
        dialogRef.current &&
        trapDialogTabKey(dialogRef.current, event.shiftKey)
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKey);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open, close]);

  if (!open) return null;

  const selectSection = (nextSection: SettingsSection) => {
    setSection(nextSection);
    useSettingsStore.setState({ drawerSection: nextSection });
  };

  return (
    <div
      ref={dialogRef}
      className="settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      tabIndex={-1}
    >
      <div className="settings__overlay" onClick={close} aria-hidden="true" />
      <div className="settings__drawer">
        <h2 id="settings-dialog-title" className="settings-visually-hidden">
          Configurações do Nexus
        </h2>
        <SettingsSurface
          section={section}
          onSelectSection={selectSection}
          onBack={close}
          returnLabel="Voltar às missões"
          returnAriaLabel="Fechar configurações e voltar às missões"
          returnKeyboardHint="Esc"
          footerActionLabel="Fechar configurações"
          searchInputRef={searchRef}
        />
      </div>
    </div>
  );
}
