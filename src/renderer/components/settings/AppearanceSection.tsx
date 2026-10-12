import { useRef, useState } from 'react';
import {
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
} from '../../styles/appearance-fonts';
import {
  TERMINAL_THEME_IDS,
  type TerminalThemeId,
} from '../../../shared/settings-types';
import { TERMINAL_THEMES } from '../../styles/terminal-theme';
import { PALETTES, applyUiTheme, type UiPalette } from '../../styles/ui-theme';
import {
  MAX_VSCODE_THEME_CHARS,
  parseVsCodeThemeText,
  upsertImportedTheme,
} from '../../styles/vscode-theme-import';
import { useSettingsStore } from '../../state/settings-store';
import { OperatorSprite } from '../OperatorSprite';
import { PixelIcon } from '../PixelIcon';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { FontFamilyPicker, FontSizePicker } from './FontFamilyPicker';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { ThemeEditorPanel } from './ThemeEditorPanel';

/**
 * Aparência global: paleta do app (tema), fontes (interface/código/terminal),
 * modo pixel (identidade retrô) e atalho para o mascote de mesa. O tema
 * restyla toda a UI via applyUiTheme; as fontes aplicam `--font-ui` /
 * `--font-mono` e o xterm (terminal.fontFamily/fontSize). Temas do VS Code
 * importados entram na mesma grade, persistidos em `ui.importedThemes`.
 */

function ThemeCard({
  label,
  ariaLabel,
  palette,
  active,
  onSelect,
}: {
  label: string;
  ariaLabel: string;
  palette: UiPalette;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-theme ${active ? 'settings-theme--active' : ''}`}
      role="radio"
      aria-checked={active}
      aria-label={ariaLabel}
      onClick={onSelect}
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
        <span className="settings-theme__name">{label}</span>
        {active && (
          <span className="settings-theme__current">
            <PixelIcon name="check" size={9} />
            em uso
          </span>
        )}
      </span>
    </button>
  );
}

export function AppearanceSection() {
  const terminal = useSettingsStore((s) => s.terminal);
  const ui = useSettingsStore((s) => s.ui);
  const updateTerminal = useSettingsStore((s) => s.update);
  const updateUi = useSettingsStore((s) => s.updateUi);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [editingTheme, setEditingTheme] = useState(false);
  const activeImported = ui.importedThemes.find(
    (theme) => theme.id === ui.activeImportedThemeId,
  );

  const selectBuiltIn = (id: TerminalThemeId) => {
    void updateTerminal({ themeId: id });
    if (activeImported) void updateUi({ activeImportedThemeId: '' });
  };

  const importThemeFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    try {
      if (file.size > MAX_VSCODE_THEME_CHARS) {
        throw new Error('Arquivo grande demais para um tema de cores (máximo de 2 MB).');
      }
      const theme = parseVsCodeThemeText(await file.text());
      await updateUi({
        importedThemes: upsertImportedTheme(ui.importedThemes, theme),
        activeImportedThemeId: theme.id,
      });
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : 'Não foi possível importar esse tema.',
      );
    }
  };

  const removeActiveImported = () => {
    if (!activeImported) return;
    void updateUi({
      importedThemes: ui.importedThemes.filter(
        (theme) => theme.id !== activeImported.id,
      ),
      activeImportedThemeId: '',
    });
  };

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
          {TERMINAL_THEME_IDS.map((id: TerminalThemeId) => (
            <ThemeCard
              key={id}
              label={TERMINAL_THEMES[id].label}
              ariaLabel={`Paleta ${TERMINAL_THEMES[id].label}`}
              palette={PALETTES[id]}
              active={!activeImported && terminal.themeId === id}
              onSelect={() => selectBuiltIn(id)}
            />
          ))}
          {ui.importedThemes.map((theme) => (
            <ThemeCard
              key={theme.id}
              label={theme.label}
              ariaLabel={`Paleta ${theme.label}, importada do VS Code`}
              palette={theme.ui}
              active={activeImported?.id === theme.id}
              onSelect={() => void updateUi({ activeImportedThemeId: theme.id })}
            />
          ))}
        </div>
        <div className="settings-appearance__import">
          <button
            type="button"
            className="settings-btn"
            onClick={() => fileRef.current?.click()}
          >
            Importar tema do VS Code
          </button>
          <button
            type="button"
            className="settings-btn"
            onClick={() => setEditingTheme((v) => !v)}
          >
            {editingTheme ? 'Fechar editor' : 'Criar tema…'}
          </button>
          {activeImported ? (
            <button
              type="button"
              className="settings-btn"
              onClick={removeActiveImported}
            >
              Remover {activeImported.label}
            </button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept=".json,.jsonc,application/json"
            hidden
            aria-label="Arquivo de tema do VS Code"
            onChange={(event) => {
              void importThemeFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
        {editingTheme && (
          <ThemeEditorPanel
            themeId={terminal.themeId}
            activeImported={activeImported ?? null}
            onSave={(theme) => {
              void updateUi({
                importedThemes: upsertImportedTheme(ui.importedThemes, theme),
                activeImportedThemeId: theme.id,
              }).then(() => setEditingTheme(false));
            }}
            onClose={() => {
              setEditingTheme(false);
              applyUiTheme(
                terminal.themeId,
                activeImported ?? null,
              );
            }}
          />
        )}
        <p className="settings-field__note settings-appearance__note">
          Use o arquivo <code>*-color-theme.json</code> da extensão. O Nexus
          ajusta o contraste para leitura e mantém o botão principal neutro.
        </p>
        {importError ? (
          <p className="settings-error" role="alert">
            {importError}
          </p>
        ) : null}
      </div>

      <div className="settings-appearance__block">
        <p className="settings-appearance__label">Fontes</p>
        <p className="settings-field__note settings-appearance__note">
          Interface, código e terminal têm preferências separadas. Uma família
          escolhida entra à frente do stack padrão — a cobertura de glifos do
          app nunca regride.
        </p>
        <div className="settings-font-grid">
          <FontFamilyPicker
            id="appearance-interface"
            label="Interface"
            defaultLabel="Inter"
            value={ui.interfaceFontFamily}
            onChange={(family) => void updateUi({ interfaceFontFamily: family })}
          />
          <FontSizePicker
            id="appearance-interface"
            label="Tamanho da interface"
            value={ui.interfaceFontSize}
            min={MIN_INTERFACE_FONT_SIZE}
            max={MAX_INTERFACE_FONT_SIZE}
            onChange={(size) => void updateUi({ interfaceFontSize: size })}
          />
          <FontFamilyPicker
            id="appearance-code"
            label="Código"
            defaultLabel="JetBrains Mono"
            value={ui.codeFontFamily}
            onChange={(family) => void updateUi({ codeFontFamily: family })}
          />
          <FontSizePicker
            id="appearance-code"
            label="Tamanho do código"
            value={ui.codeFontSize}
            min={MIN_CODE_FONT_SIZE}
            max={MAX_CODE_FONT_SIZE}
            onChange={(size) => void updateUi({ codeFontSize: size })}
          />
          <FontFamilyPicker
            id="appearance-terminal"
            label="Terminal"
            defaultLabel="JetBrains Mono"
            value={terminal.fontFamily}
            onChange={(family) => void updateTerminal({ fontFamily: family })}
            note="Aplicado a todos os terminais abertos e aos novos."
          />
          <FontSizePicker
            id="appearance-terminal"
            label="Tamanho do terminal"
            value={terminal.fontSize}
            min={9}
            max={24}
            onChange={(size) => void updateTerminal({ fontSize: size })}
          />
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
