import {
  TERMINAL_THEME_IDS,
  type TerminalThemeId,
} from '../../../shared/settings-types';
import { TERMINAL_THEMES } from '../../styles/terminal-theme';
import { useSettingsStore } from '../../state/settings-store';
import { OperatorSprite } from '../OperatorSprite';

/**
 * Aparência global: modo pixel (identidade retrô) e paleta do app.
 * O tema de cores segue os presets do terminal e restyla toda a UI via
 * applyUiTheme — fonte/shell do xterm ficam em Terminal.
 */

export function AppearanceSection() {
  const terminal = useSettingsStore((s) => s.terminal);
  const ui = useSettingsStore((s) => s.ui);
  const updateTerminal = useSettingsStore((s) => s.update);
  const updateUi = useSettingsStore((s) => s.updateUi);

  return (
    <section className="settings-appearance">
      <h3 className="settings-detail__title">Aparência</h3>
      <p className="settings-detail__hint">
        Identidade visual do cockpit: modo pixel liga cantos retos, fonte VT323 e
        menos antialias. A paleta aplica-se a barras, drawers e painéis.
      </p>

      <div className="settings-appearance__preview" aria-hidden>
        <OperatorSprite
          mood="idle"
          size={32}
          tier="RECRUTA"
          branch="base"
          skin={null}
        />
        <span className="settings-appearance__preview-copy">
          <strong>Operador</strong>
          <span>HUD e ícones já falam pixel; o modo estende ao shell.</span>
        </span>
      </div>

      <label className="settings-toggle-card">
        <span className="settings-toggle-card__copy">
          <strong>Modo pixel</strong>
          <span>
            Cantos retos, tipografia bitmap e grid mais evidente. Reversível a
            qualquer momento.
          </span>
        </span>
        <input
          type="checkbox"
          checked={ui.pixelMode}
          aria-label="Ativar modo pixel"
          onChange={(e) => void updateUi({ pixelMode: e.target.checked })}
        />
      </label>

      <div className="settings-appearance__block">
        <p className="settings-appearance__label">Paleta do app</p>
        <p className="settings-field__note settings-appearance__note">
          Mesmos presets do terminal; mudam a UI inteira e os panes abertos.
        </p>
        <div className="settings-theme-grid">
          {TERMINAL_THEME_IDS.map((id: TerminalThemeId) => {
            const entry = TERMINAL_THEMES[id];
            return (
              <button
                key={id}
                type="button"
                className={`settings-theme ${terminal.themeId === id ? 'settings-theme--active' : ''}`}
                style={{
                  background: String(entry.theme.background),
                  color: String(entry.theme.foreground),
                }}
                aria-pressed={terminal.themeId === id}
                aria-label={`Paleta ${entry.label}`}
                onClick={() => void updateTerminal({ themeId: id })}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
