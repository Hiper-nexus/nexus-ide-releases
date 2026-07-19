import { useEffect } from 'react';
import { useCheatsheetStore } from '../state/cheatsheet-store';
import { PixelIcon } from './PixelIcon';
import { formatShortcut } from '../lib/platform';

/**
 * Cheatsheet de atalhos (⌘/): a resposta da heurística "ajuda no contexto" —
 * todos os aceleradores num overlay, sem sair do fluxo nem abrir docs.
 */

const GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Comando',
    keys: [
      [formatShortcut('mod', 'K'), 'Command palette: panes, missões e ações'],
      [formatShortcut('mod', 'N'), 'Nova missão'],
      [formatShortcut('mod', 'B'), 'Painel de operações (pipeline)'],
      [formatShortcut('mod', ','), 'Configurações'],
      [formatShortcut('mod', '/'), 'Este cheatsheet'],
    ],
  },
  {
    title: 'Frota',
    keys: [
      [formatShortcut('mod', '1-9'), 'Focar o N-ésimo pane'],
      [formatShortcut('mod', 'D'), 'Dividir o pane à direita'],
      [formatShortcut('mod', 'shift', 'D'), 'Dividir o pane abaixo'],
      [formatShortcut('mod', 'W'), 'Fechar o pane focado'],
      ['duplo-clique', 'Renomear o pane (no título)'],
    ],
  },
  {
    title: 'Superfícies',
    keys: [
      ['Esc', 'Fechar overlay/dialog em foco'],
      ['F', 'Centralizar o canvas (modo canvas)'],
      [formatShortcut('mod', 'shift', 'O'), 'Perfil do Operador'],
    ],
  },
];

export function KeyboardCheatsheet() {
  const open = useCheatsheetStore((s) => s.open);
  const close = useCheatsheetStore((s) => s.close);

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
      <div className="cheatsheet__overlay" onClick={close} />
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
          {GROUPS.map((group) => (
            <section key={group.title} className="cheatsheet__group">
              <h3 className="cheatsheet__group-title">{group.title}</h3>
              <dl className="cheatsheet__list">
                {group.keys.map(([keys, label]) => (
                  <div key={keys} className="cheatsheet__row">
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{label}</dd>
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
