import {
  TERMINAL_THEME_IDS,
  type TerminalThemeId,
} from '../../../shared/settings-types';
import { TERMINAL_THEMES } from '../../styles/terminal-theme';
import { PALETTES } from '../../styles/ui-theme';
import { useSettingsStore } from '../../state/settings-store';
import { OperatorSprite } from '../OperatorSprite';
import { PixelIcon } from '../PixelIcon';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Aparência global: paleta do app (tema), modo pixel (identidade retrô) e
 * atalho para o mascote de mesa. O tema restyla toda a UI via applyUiTheme —
 * fonte/shell do xterm ficam em Terminal.
 */

export function AppearanceSection() {
  const terminal = useSettingsStore((s) => s.terminal);
  const ui = useSettingsStore((s) => s.ui);
  const updateTerminal = useSettingsStore((s) => s.update);
  const updateUi = useSettingsStore((s) => s.updateUi);

  return (
    <section className="settings-appearance">
      <SettingsSectionTitle>Aparência</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Escolha as cores do app e personalize o estilo da interface.
      </p>

      <div className="settings-appearance__block">
        <p className="settings-appearance__label">Tema de cores</p>
        <p className="settings-field__note settings-appearance__note">
          Cada cartão mostra a paleta real do app. A escolha aplica ao app
          inteiro e aos terminais abertos.
        </p>
        <div
          className="settings-theme-grid"
          role="radiogroup"
          aria-label="Tema de cores"
        >
          {TERMINAL_THEME_IDS.map((id: TerminalThemeId) => {
            const entry = TERMINAL_THEMES[id];
            const palette = PALETTES[id];
            const active = terminal.themeId === id;
            return (
              <button
                key={id}
                type="button"
                className={`settings-theme ${active ? 'settings-theme--active' : ''}`}
                role="radio"
                aria-checked={active}
                aria-label={`Paleta ${entry.label}`}
                onClick={() => void updateTerminal({ themeId: id })}
              >
                <span
                  className="settings-theme__preview"
                  style={{
                    background: palette.bg,
                    borderColor: palette.borderStrong,
                  }}
                  aria-hidden
                >
                  <span
                    className="settings-theme__chrome"
                    style={{
                      background: palette.bgBar,
                      borderBottomColor: palette.border,
                    }}
                  >
                    <i style={{ background: palette.textFaint }} />
                    <i style={{ background: palette.textFaint }} />
                    <i style={{ background: palette.accent }} />
                  </span>
                  <span className="settings-theme__lines">
                    <i
                      className="settings-theme__line"
                      style={{ background: palette.text }}
                    />
                    <i
                      className="settings-theme__line settings-theme__line--dim"
                      style={{ background: palette.textDim }}
                    />
                    <i
                      className="settings-theme__cta"
                      style={{ background: palette.btnPrimary }}
                    />
                  </span>
                </span>
                <span className="settings-theme__foot">
                  <span className="settings-theme__name">{entry.label}</span>
                  {active && (
                    <span className="settings-theme__current">
                      <PixelIcon name="check" size={9} />
                      em uso
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-appearance__block">
        <p className="settings-appearance__label">Estilo</p>
        <label className="settings-toggle-card">
          <span className="settings-toggle-card__copy">
            <strong>Modo pixel</strong>
            <span>
              Letras e cantos em estilo retrô. Você pode desativar quando quiser.
            </span>
          </span>
          <input
            type="checkbox"
            checked={ui.pixelMode}
            aria-label="Ativar modo pixel"
            onChange={(e) => void updateUi({ pixelMode: e.target.checked })}
          />
        </label>
      </div>

      <div className="settings-appearance__block">
        <p className="settings-appearance__label">Mascote</p>
        <div className="settings-appearance__preview">
          <OperatorSprite
            mood="idle"
            size={32}
            tier="RECRUTA"
            branch="base"
            skin={null}
          />
          <span className="settings-appearance__preview-copy">
            <strong>Operador</strong>
            <span>
              Seu pet de mesa acompanha as missões. Troque o mascote, crie um
              com IA ou importe spritesheets em Meus pets.
            </span>
          </span>
          <button
            type="button"
            className="settings-btn settings-appearance__preview-cta"
            onClick={() => useProductNavigationStore.getState().openSettings('pets')}
          >
            Abrir Meus pets
          </button>
        </div>
      </div>
    </section>
  );
}
