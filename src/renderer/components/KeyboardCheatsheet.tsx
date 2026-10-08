import { useEffect } from 'react';
import { useCheatsheetStore } from '../state/cheatsheet-store';
import { PixelIcon } from './PixelIcon';
import {
  SHORTCUT_GROUP_LABELS,
  effectiveShortcutKeys,
  shortcutsInGroup,
  type ShortcutGroupId,
} from '../lib/shortcuts';
import { useSettingsStore } from '../state/settings-store';

/**
 * Cheatsheet de atalhos (⌘/): a resposta da heurística "ajuda no contexto" —
 * todos os aceleradores num overlay, sem sair do fluxo nem abrir docs.
 *
 * A lista vem de `lib/shortcuts.ts`, fonte única compartilhada com
 * Configurações › Atalhos e o rodapé do Home. Três listas escritas à mão
 * divergiram, e ⌘⇧N não estava em nenhuma delas.
 */

const GROUP_ORDER: ShortcutGroupId[] = ['command', 'fleet', 'surfaces'];

export function KeyboardCheatsheet() {
  const open = useCheatsheetStore((s) => s.open);
  const close = useCheatsheetStore((s) => s.close);
  const keybindingOverrides = useSettingsStore((s) => s.ui.keybindings);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="cheatsheet" role="dialog" aria-label="Atalhos do teclado">
      <div
        className="cheatsheet__overlay overlay-scrim-glass overlay-scrim-enter"
        onClick={close}
      />
      <div className="cheatsheet__panel">
        <header className="cheatsheet__head">
          <span className="cheatsheet__eyebrow">Atalhos</span>
          <h2 className="cheatsheet__title">Teclado primeiro</h2>
          <button
            type="button"
            className="cheatsheet__close"
            onClick={close}
            aria-label="Fechar cheatsheet"
          >
            <PixelIcon name="close" size={12} />
          </button>
        </header>
        <div className="cheatsheet__groups">
          {GROUP_ORDER.map((groupId) => (
            <section key={groupId} className="cheatsheet__group">
              <h3 className="cheatsheet__group-title">
                {SHORTCUT_GROUP_LABELS[groupId]}
              </h3>
              <dl className="cheatsheet__list">
                {shortcutsInGroup(groupId).map((entry) => (
                  <div key={entry.id} className="cheatsheet__row">
                    <dt>
                      <kbd>{effectiveShortcutKeys(entry, keybindingOverrides)}</kbd>
                    </dt>
                    <dd>{entry.action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
